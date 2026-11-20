"""Real subprocess MCP tests. All writes use a fresh temporary memory root."""
import json, os, pathlib, queue, subprocess, tempfile, threading
ROOT=pathlib.Path(__file__).resolve().parents[1]
NODE=os.environ.get('DSH_TEST_NODE','node')

def exercise(mode):
    with tempfile.TemporaryDirectory(prefix='dsh-mt-protocol-') as temp:
        env={**os.environ,'MEMORY_TREE_ROOT':temp}
        p=subprocess.Popen([NODE,str(ROOT/'src/server.js')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env)
        replies=queue.Queue()
        def read():
            try:
                while True:
                    if mode=='jsonl':
                        data=p.stdout.readline()
                        if not data: break
                    else:
                        header=p.stdout.readline()
                        if not header: break
                        size=int(header.decode().split(':',1)[1])
                        assert p.stdout.readline()==b'\r\n'
                        data=p.stdout.read(size)
                    replies.put(json.loads(data))
            except Exception as e: replies.put(e)
        threading.Thread(target=read,daemon=True).start()
        seq=0
        def request(method,params=None):
            nonlocal seq
            seq+=1
            raw=json.dumps({'jsonrpc':'2.0','id':seq,'method':method,'params':params or {}},ensure_ascii=False).encode()
            p.stdin.write(raw+b'\n' if mode=='jsonl' else f'Content-Length: {len(raw)}\r\n\r\n'.encode()+raw)
            p.stdin.flush()
            r=replies.get(timeout=3)
            if isinstance(r,Exception): raise r
            assert r['id']==seq,r
            return r
        def call(name,args=None):
            return request('tools/call',{'name':name,'arguments':args or {}})['result']
        try:
            init = request('initialize', {'protocolVersion': '2025-11-25', 'capabilities': {},
                                          'clientInfo': {'name': 'local-check', 'version': '1'}})
            assert init['result']['protocolVersion'] == '2025-11-25'
            assert request('ping')['result'] == {}
            names = {tool['name'] for tool in request('tools/list')['result']['tools']}
            assert {'mt_merge', 'mt_get_checkpoint', 'mt_search'} <= names

            def content(result):
                assert not result.get('isError'), result
                return json.loads(result['content'][0]['text'])

            project = '测试项目'
            args = {'project': project}
            assert content(call('mt_status'))['projects'] == []
            assert call('mt_get_context', args)['isError']
            assert call('mt_search', {'query': '协议测试'})['isError']
            assert not list(pathlib.Path(temp).iterdir())
            assert call('unknown_tool')['isError']
            assert call('mt_set_project', {'project': '../escape'})['isError']
            assert content(call('mt_set_project', args))['project'] == project
            assert content(call('mt_route', {**args, 'message': '继续'}))['project'] == project
            branch = content(call('mt_branch', {**args, 'title': 'test'}))
            merge = {**args, 'branchId': branch['id']}
            assert call('mt_merge', merge)['isError']
            entries = [{'category': 'results', 'text': '协议测试通过', 'source': 'isolated test',
                        'verification': 'tool-verified', 'date': '2026-11-20'}]
            assert call('mt_merge', {**merge, 'entries': entries, 'force': True})['isError']
            assert content(call('mt_merge', {**merge, 'entries': entries}))['archived']
            cp = content(call('mt_checkpoint', {**args, 'title': 'test'}))
            assert '协议测试' in content(call('mt_get_checkpoint', {**args, 'id': cp['id']}))['markdown']
            assert content(call('mt_search', {**args, 'query': '协议测试'}))[0]['verification'] == 'tool-verified'
            print(f'PASS {mode}: handshake, discovery, ping, validation, read-only queries, write/read, checkpoint/search')
        except queue.Empty as error:
            raise AssertionError(f'{mode} response timed out') from error
        finally:
            p.stdin.close()
            try: p.wait(timeout=2)
            except subprocess.TimeoutExpired: p.kill(); p.wait(timeout=2)
            p.stdout.close(); p.stderr.close()

if __name__=='__main__':
    exercise('jsonl')
    exercise('legacy')
