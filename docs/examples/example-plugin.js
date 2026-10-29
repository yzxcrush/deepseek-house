// @id user.demo
// @name 随机名言
// @version 1.0.0
// @author DeepSeek House 示例
// @description 本地名言库：/quote 随机返回一句励志名言，同时向模型提供 random_quote 工具；无需网络。
//
// 这个文件可以直接在 App 里安装：
//   打开「插件」页 → 安装插件 → 粘贴下面全部代码（或选择本文件）→ 安装。
// 安装校验规则（由 app/assets/web/js/plugins.js 的 installFromCode 执行）：
//   1. 开头注释必须提供 @id（必须以 user. 开头）、@name、@version；
//   2. 必须调用 window.DSPlugins.register({...}) 且 id 与 @id 一致；
//   3. 一个文件只能注册一个插件，且至少提供命令、工具或钩子之一。
(function () {
  "use strict";

  // 全部数据都在本地，不发起任何网络请求。
  var QUOTES = [
    { text: "路虽远，行则将至；事虽难，做则必成。", author: "荀子" },
    { text: "不积跬步，无以至千里；不积小流，无以成江海。", author: "荀子" },
    { text: "宝剑锋从磨砺出，梅花香自苦寒来。", author: "《警世贤文》" },
    { text: "千里之行，始于足下。", author: "老子" },
    { text: "知之者不如好之者，好之者不如乐之者。", author: "孔子" },
    { text: "天行健，君子以自强不息。", author: "《周易》" },
    { text: "亦余心之所善兮，虽九死其犹未悔。", author: "屈原" },
    { text: "长风破浪会有时，直挂云帆济沧海。", author: "李白" },
    { text: "纸上得来终觉浅，绝知此事要躬行。", author: "陆游" },
    { text: "生活的理想，就是为了理想的生活。", author: "张闻天" },
    { text: "我们唯一不得不恐惧的，是恐惧本身。", author: "罗斯福" },
    { text: "Stay hungry, stay foolish.", author: "Steve Jobs" }
  ];

  function pickQuote(topic) {
    var pool = QUOTES;
    if (topic) {
      // 简单的主题过滤：按文本/作者做包含匹配；没有匹配则回退到全部。
      var keyword = String(topic).trim();
      var matched = [];
      for (var i = 0; i < QUOTES.length; i += 1) {
        if (QUOTES[i].text.indexOf(keyword) >= 0 || QUOTES[i].author.indexOf(keyword) >= 0) {
          matched.push(QUOTES[i]);
        }
      }
      if (matched.length) pool = matched;
    }
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function formatQuote(quote) {
    return "「" + quote.text + "」\n—— " + quote.author;
  }

  function quoteCommand(ctx, args) {
    var topic = "";
    if (typeof args === "string") topic = args.trim();
    else if (Array.isArray(args)) topic = args.join(" ").trim();
    var quote = pickQuote(topic);
    return formatQuote(quote);
  }

  function quoteTool(ctx, args) {
    var topic = args && typeof args.topic === "string" ? args.topic.trim() : "";
    var quote = pickQuote(topic);
    return "随机名言（共 " + QUOTES.length + " 条本地数据）：\n" + formatQuote(quote);
  }

  window.DSPlugins.register({
    id: "user.demo",
    name: "随机名言",
    version: "1.0.0",
    author: "DeepSeek House 示例",
    description:
      "内置 12 条本地名言。发送 /quote 随机来一句；模型也可以通过 random_quote 工具主动调用。完全离线，可作为编写自己插件的模板。",
    commands: [
      {
        name: "quote",
        description: "随机返回一句名言",
        usage: "/quote [关键词]",
        run: quoteCommand
      }
    ],
    tools: [
      {
        name: "random_quote",
        description:
          "从本地名言库随机返回一句名言，可传入关键词（如作者名、主题词）进行过滤；无需网络。",
        parameters: {
          type: "object",
          properties: {
            topic: {
              type: "string",
              description: "可选关键词，用于过滤名言（匹配文本或作者）；留空则完全随机"
            }
          },
          required: []
        },
        run: quoteTool
      }
    ]
  });
})();
