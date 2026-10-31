// @id official.translator
// @name 翻译助手
// @version 1.1.0
// @author DeepSeek House
// @description 中英互译 / 多语言翻译，模型工具 translate_text + 命令 /translate；无需 API Key。
// @tags 翻译,工具,联网
// @category 语言
(function () {
  "use strict";

  var LANG = {
    "中文": "zh-CN", "英文": "en", "日文": "ja", "韩文": "ko",
    "法文": "fr", "德文": "de", "俄文": "ru", "西班牙文": "es",
    "zh": "zh-CN", "en": "en", "ja": "ja", "ko": "ko"
  };

  function targetLang(raw) {
    var v = String(raw || "").trim();
    return LANG[v] || v || "zh-CN";
  }

  async function translate(ctx, text, target) {
    var q = String(text || "").trim();
    if (!q) return "请提供要翻译的文本。";
    if (q.length > 1200) q = q.slice(0, 1200);
    var lang = targetLang(target);
    var url = "https://api.mymemory.translated.net/get?q=" + encodeURIComponent(q) + "&langpair=auto%7C" + encodeURIComponent(lang);
    try {
      var res = await ctx.http.fetch(url, { timeout: 20000, headers: { Accept: "application/json" } });
      var data = JSON.parse(res.body || "{}");
      var out = data && data.responseData && data.responseData.translatedText;
      if (!out) return "翻译失败：接口未返回结果。";
      return "译文（" + lang + "）：\n" + out;
    } catch (e) {
      return "翻译失败：" + (e && e.message ? e.message : "网络错误");
    }
  }

  window.DSPlugins.register({
    id: "official.translator",
    name: "翻译助手",
    version: "1.1.0",
    author: "DeepSeek House",
    description: "中英互译 / 多语言翻译；模型可调用 translate_text，用户可用 /translate。",
    commands: [
      { name: "translate", description: "翻译文本", usage: "/translate [目标语言] 文本", run: async function (ctx, args) {
        var arr = Array.isArray(args) ? args : String(args || "").split(/\s+/);
        var target = arr[0] || "zh-CN";
        var text = arr.slice(1).join(" ") || arr[0] || "";
        return await translate(ctx, text, target);
      } }
    ],
    tools: [
      { name: "translate_text", description: "把文本翻译成目标语言（中文/英文/日文/韩文等）。", parameters: { type: "object", properties: { text: { type: "string", description: "要翻译的文本" }, target: { type: "string", description: "目标语言，如 zh-CN/en/ja" } }, required: ["text"] }, run: async function (ctx, args) { return await translate(ctx, args && args.text, args && args.target); } }
    ]
  });
})();
