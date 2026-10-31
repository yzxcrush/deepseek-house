// @id official.ipinfo
// @name IP 信息查询
// @version 1.0.0
// @author DeepSeek House
// @description 查询当前公网 IP 与归属地、运营商；模型工具 get_ip_info + 命令 /ip。
// @tags 网络,IP,联网
// @category 网络
(function () {
  "use strict";

  async function query(ctx) {
    try {
      var res = await ctx.http.fetch("https://ipapi.co/json/", { timeout: 20000, headers: { Accept: "application/json" } });
      var d = JSON.parse(res.body || "{}");
      if (!d || !d.ip) return "IP 查询失败：接口未返回数据。";
      return ["🌐 公网 IP：" + d.ip, "📍 归属地：" + [d.country_name, d.region, d.city].filter(Boolean).join(" / "), "📡 运营商：" + (d.org || "未知"), "🕓 时区：" + (d.timezone || "未知")].join("\n");
    } catch (e) {
      return "IP 查询失败：" + (e && e.message ? e.message : "网络错误");
    }
  }

  window.DSPlugins.register({
    id: "official.ipinfo",
    name: "IP 信息查询",
    version: "1.0.0",
    author: "DeepSeek House",
    description: "查询公网 IP 归属地、运营商与时区（ipapi.co，免 Key）。",
    commands: [{ name: "ip", description: "查询本机公网 IP", usage: "/ip", run: function (ctx) { return query(ctx); } }],
    tools: [{ name: "get_ip_info", description: "查询当前网络出口公网 IP 及其归属地/运营商。", parameters: { type: "object", properties: {}, required: [] }, run: function (ctx) { return query(ctx); } }]
  });
})();
