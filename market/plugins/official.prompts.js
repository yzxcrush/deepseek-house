// @id official.prompts
// @name 提示词库
// @version 1.1.0
// @author DeepSeek House
// @description 内置常用提示词模板（写作/代码/翻译/总结/面试/小红书），/prompt 快速取用。完全离线。
// @tags 提示词,效率,离线
// @category 效率
(function () {
  "use strict";

  var LIB = {
    "总结": "请把下面的内容压缩成要点清单（3-6 条），保留关键数据与结论，去掉客套话：\n",
    "写作": "请以专业但自然的中文写一篇 800 字左右的文章，主题是：\n要求：有清晰结构、具体例子、不要用“首先/其次/最后”这样的套话。",
    "代码": "请审查下面的代码：指出 bug、边界条件、性能问题，并给出修改后的完整代码。\n代码：\n",
    "翻译": "请把下面内容翻译成地道中文，保留专业术语，遇到不确定的术语给出英文原文：\n",
    "面试": "请你扮演 10 年经验的面试官，针对下面岗位做一次模拟面试：\n岗位：\n请一次问 1 个问题，等我回答后再追问或给反馈。",
    "小红书": "请写一篇小红书风格笔记：标题要有网感（带 emoji），正文 300 字内、分段短、口语化，结尾带 3-5 个话题标签。主题：\n"
  };

  function list() {
    return "提示词库（" + Object.keys(LIB).length + " 个）：\n" + Object.keys(LIB).map(function (k) { return "· /prompt " + k; }).join("\n");
  }

  function get(name) {
    var key = String(name || "").trim();
    if (!key) return list();
    if (LIB[key]) return LIB[key];
    var keys = Object.keys(LIB);
    for (var i = 0; i < keys.length; i++) { if (keys[i].indexOf(key) >= 0) return LIB[keys[i]]; }
    return "未找到提示词「" + key + "」，可用：" + keys.join("、");
  }

  window.DSPlugins.register({
    id: "official.prompts",
    name: "提示词库",
    version: "1.1.0",
    author: "DeepSeek House",
    description: "常用提示词模板库，/prompt 查看或取用；离线可用。",
    commands: [{ name: "prompt", description: "取用提示词模板", usage: "/prompt [名称]", run: function (ctx, args) { return get(Array.isArray(args) ? args.join(" ") : args); } }],
    tools: [{ name: "get_prompt_template", description: "获取常用提示词模板内容（总结/写作/代码/翻译/面试/小红书）。", parameters: { type: "object", properties: { name: { type: "string", description: "模板名称，留空则列出全部" } }, required: [] }, run: function (ctx, args) { return get(args && args.name); } }]
  });
})();
