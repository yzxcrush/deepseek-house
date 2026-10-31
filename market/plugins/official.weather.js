// @id official.weather
// @name 天气查询
// @version 1.1.0
// @author DeepSeek House
// @description 查询城市实时天气与未来三天预报；模型工具 get_weather + 命令 /weather。
// @tags 天气,联网,生活
// @category 生活
(function () {
  "use strict";

  function fmt(c) {
    var parts = [];
    parts.push("📍 " + (c.city || ""));
    parts.push("🌡 " + (c.temp_C || "?") + "°C（体感 " + (c.FeelsLikeC || "?") + "°C）");
    parts.push("☁️ " + (c.weatherDesc && c.weatherDesc[0] ? c.weatherDesc[0].value : ""));
    parts.push("💧 湿度 " + (c.humidity || "?") + "%   💨 风速 " + (c.windspeedKmph || "?") + " km/h");
    return parts.join("\n");
  }

  async function query(ctx, city) {
    var name = String(city || "").trim();
    if (!name) return "请提供城市名，例如：/weather 北京";
    try {
      var url = "https://wttr.in/" + encodeURIComponent(name) + "?format=j1";
      var res = await ctx.http.fetch(url, { timeout: 20000 });
      var data = JSON.parse(res.body || "{}");
      var cur = data && data.current_condition && data.current_condition[0];
      if (!cur) return "天气查询失败：接口未返回数据。";
      cur.city = name;
      var out = [fmt(cur)];
      if (Array.isArray(data.weather) && data.weather.length) {
        out.push("\n未来三天：");
        data.weather.slice(0, 3).forEach(function (d) {
          out.push(d.date + "  " + d.mintempC + "~" + d.maxtempC + "°C");
        });
      }
      return out.join("\n");
    } catch (e) {
      return "天气查询失败：" + (e && e.message ? e.message : "网络错误");
    }
  }

  window.DSPlugins.register({
    id: "official.weather",
    name: "天气查询",
    version: "1.1.0",
    author: "DeepSeek House",
    description: "查询城市实时天气与三天预报（wttr.in，免 Key）。",
    commands: [{ name: "weather", description: "查询城市天气", usage: "/weather 北京", run: async function (ctx, args) { return await query(ctx, Array.isArray(args) ? args.join(" ") : args); } }],
    tools: [{ name: "get_weather", description: "查询某个城市的实时天气与未来三天预报。", parameters: { type: "object", properties: { city: { type: "string", description: "城市名，如 北京 / Shanghai" } }, required: ["city"] }, run: async function (ctx, args) { return await query(ctx, args && args.city); } }]
  });
})();
