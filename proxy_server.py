#!/usr/bin/env python3
"""A股仪表盘极简实时代理 — 标准库单文件，零依赖

作用：把浏览器对东方财富 push2 接口的 JSONP 请求转发到服务端，
      解决本机/沙箱网络到 push2.eastmoney.com 不可达（只能走延迟源）的问题。
      服务端通常能直连 push2，从而把广度/行业/北向数据变成实时。

用法：
  1. 运行：python3 proxy_server.py
  2. 在 dashboard.html 里点「配置代理地址」，填入 http://localhost:8899
  3. 刷新页面，即走实时服务端代理。

可改端口：python3 proxy_server.py 8899
"""

import http.server
import re
import sys
import urllib.request
import urllib.parse

PORT = 8899
DEFAULT_HOST = 'push2.eastmoney.com'
# eastmoney 部分接口校验 Referer（非 eastmoney 域返回 ErrCode:-999），按 host 指定合法 Referer 以通过校验。
# api.fund / fundf10 需要 fundf10.eastmoney.com 域的 Referer；其余（push2 等）用 quote.eastmoney.com。
REFERERS = {
    'api.fund.eastmoney.com': 'http://fundf10.eastmoney.com/',
    'fundf10.eastmoney.com': 'http://fundf10.eastmoney.com/',
}


class ProxyHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # 安静运行，不打印每个请求

    def _cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        if not self.path.startswith('/proxy'):
            self.send_error(404, 'Use /proxy?host=...&path=...')
            return

        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        host = qs.get('host', [DEFAULT_HOST])[0]
        path = qs.get('path', [''])[0]
        cb = qs.get('cb', [''])[0]  # 前端 JSONP callback
        if not path:
            self.send_error(400, 'path required')
            return

        # 把前端 callback 写入转发的 path，确保返回的 JSONP 能被前端正确执行。
        # 注意：api.fund.eastmoney.com 的 JSONP 参数名是 callback=，其余（push2 等）用 cb=，按 host 区分。
        if cb:
            if 'cb=' in path or 'callback=' in path:
                path = re.sub(r'[?&](cb|callback)=[^&]*', '', path)
            sep = '&' if '?' in path else '?'
            if host == 'api.fund.eastmoney.com':
                path = path + sep + 'callback=' + urllib.parse.quote(cb, safe='')
            else:
                path = path + sep + 'cb=' + urllib.parse.quote(cb, safe='')

        referer = REFERERS.get(host, 'https://quote.eastmoney.com/')
        target = f'https://{host}{path}'
        try:
            req = urllib.request.Request(
                target,
                headers={
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': referer,
                    'Accept': '*/*',
                }
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read()
                self.send_response(200)
                self.send_header('Content-Type', 'application/javascript; charset=utf-8')
                self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
                self._cors_headers()
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as e:
            self.send_response(502)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self._cors_headers()
            self.end_headers()
            self.wfile.write(f'proxy upstream error: {e.code} {e.reason}'.encode('utf-8'))
        except Exception as e:
            self.send_response(502)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self._cors_headers()
            self.end_headers()
            self.wfile.write(f'proxy error: {e}'.encode('utf-8'))


if __name__ == '__main__':
    if len(sys.argv) > 1:
        PORT = int(sys.argv[1])
    print(f'[proxy] listening http://0.0.0.0:{PORT}')
    print(f'[proxy] dashboard.html 中设置代理地址：http://localhost:{PORT}')
    print('[proxy] 按 Ctrl+C 停止')
    http.server.HTTPServer(('0.0.0.0', PORT), ProxyHandler).serve_forever()
