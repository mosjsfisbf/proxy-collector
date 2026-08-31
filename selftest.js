
const { HttpsProxyAgent } = require("https-proxy-agent");
async function test() {
  const proxyUrl = "http://185.88.177.40:80";
  const traceUrl = "https://www.cloudflare.com/cdn-cgi/trace";
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  const start = Date.now();
  try {
    const res = await fetch(traceUrl, {
      signal: ctrl.signal,
      headers: { "user-agent": "proxy-collector/2.0" },
      agent: new HttpsProxyAgent(proxyUrl),
    });
    clearTimeout(t);
    console.log("status:", res.status);
    const text = await res.text();
    const loc = text.match(/^loc=(.+)$/m);
    const ip = text.match(/^ip=(.+)$/m);
    console.log("latency:", Date.now() - start, "ms");
    console.log("exit country:", loc ? loc[1] : "?", "| exit ip:", ip ? ip[1] : "?");
  } catch (e) {
    clearTimeout(t);
    console.log("FAILED (proxy dead or not tunneling):", e.message);
  }
}
test();
