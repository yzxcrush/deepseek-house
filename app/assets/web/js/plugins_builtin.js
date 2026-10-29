/*!
 * plugins_builtin.js — DeepSeek House 内置插件（SPEC §5.3）
 *
 * 内置插件全部 builtin:true：不可删除、可禁用；默认启用。
 * 本文件只调用 window.DSPlugins.register()，不操作 DOM、不依赖网络（除网页抓取插件）。
 *
 * 插件清单：
 *   calculator  计算器（安全表达式求值，无 eval / new Function）
 *   time        时间日期（当前时间 + 倒计时）
 *   web         网页抓取（仅 https，localhost 例外）
 *   prompts     提示词模板库（本地模板，无需网络）
 *   random      随机数与骰子
 *   units       单位换算
 */
(function (global) {
  "use strict";

  var DSPlugins = global.DSPlugins;
  if (!DSPlugins || typeof DSPlugins.register !== "function") {
    try {
      (global.console || console).warn("[DSPlugins][builtin] 未找到 window.DSPlugins，内置插件未注册");
    } catch (e) {
      /* ignore */
    }
    return;
  }

  var AUTHOR = "DeepSeek House";

  /* ------------------------------------------------------------------ *
   * 通用小工具
   * ------------------------------------------------------------------ */
  function errorText(err) {
    if (err == null) return "未知错误";
    if (typeof err === "string") return err;
    if (err.message) return String(err.message);
    return String(err);
  }

  // 斜杠命令参数：app.js 可能传字符串或字符串数组
  function argText(args) {
    if (args == null) return "";
    if (typeof args === "string") return args.trim();
    if (Array.isArray(args)) return args.join(" ").trim();
    return String(args).trim();
  }

  function roundNumber(value, digits) {
    var factor = Math.pow(10, digits == null ? 10 : digits);
    var out = Math.round(value * factor) / factor;
    if (Object.is(out, -0)) out = 0;
    return out;
  }

  function isPlainFinite(value) {
    return typeof value === "number" && isFinite(value);
  }

  /* ================================================================== *
   * 插件 1：计算器
   * 安全表达式求值：手写词法分析 + 递归下降语法分析，绝不使用 eval /
   * new Function，因此用户输入无法执行任意代码。
   * ================================================================== */
  function CalcError(message) {
    this.name = "CalcError";
    this.message = message;
  }
  CalcError.prototype = Object.create(Error.prototype);
  CalcError.prototype.constructor = CalcError;

  var CALC_CONSTS = { pi: Math.PI, e: Math.E };

  var CALC_FUNCS = {
    sqrt: {
      min: 1,
      max: 1,
      fn: function (v) {
        if (v < 0) throw new CalcError("sqrt 的参数不能为负数");
        return Math.sqrt(v);
      }
    },
    abs: { min: 1, max: 1, fn: Math.abs },
    sin: { min: 1, max: 1, fn: Math.sin },
    cos: { min: 1, max: 1, fn: Math.cos },
    tan: { min: 1, max: 1, fn: Math.tan },
    ln: {
      min: 1,
      max: 1,
      fn: function (v) {
        if (v <= 0) throw new CalcError("ln 的参数必须大于 0");
        return Math.log(v);
      }
    },
    log: {
      min: 1,
      max: 2,
      fn: function (v, base) {
        if (v <= 0) throw new CalcError("log 的参数必须大于 0");
        if (base === undefined) {
          return Math.log(v) / Math.LN10;
        }
        if (base <= 0 || base === 1) throw new CalcError("log 的底数必须大于 0 且不等于 1");
        return Math.log(v) / Math.log(base);
      }
    },
    exp: { min: 1, max: 1, fn: Math.exp },
    round: { min: 1, max: 1, fn: Math.round },
    floor: { min: 1, max: 1, fn: Math.floor },
    ceil: { min: 1, max: 1, fn: Math.ceil }
  };

  var CALC_NUMBER_RE = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;

  function calcTokenize(source) {
    var s = source.replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-").replace(/\*\*/g, "^").replace(/，/g, ",");
    var tokens = [];
    var i = 0;
    while (i < s.length) {
      var ch = s.charAt(i);
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        i += 1;
        continue;
      }
      if (/[0-9.]/.test(ch)) {
        var numMatch = CALC_NUMBER_RE.exec(s.slice(i));
        if (!numMatch) {
          throw new CalcError("数字格式不正确：" + s.slice(i, i + 12));
        }
        var num = Number(numMatch[0]);
        if (!isFinite(num)) throw new CalcError("数字超出范围：" + numMatch[0]);
        tokens.push({ type: "num", value: num });
        i += numMatch[0].length;
        continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        var idMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
        tokens.push({ type: "ident", value: idMatch[0].toLowerCase() });
        i += idMatch[0].length;
        continue;
      }
      if (ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "%" || ch === "^") {
        tokens.push({ type: "op", value: ch });
        i += 1;
        continue;
      }
      if (ch === "(" || ch === ")" || ch === ",") {
        tokens.push({ type: ch });
        i += 1;
        continue;
      }
      throw new CalcError("不支持的字符：" + ch);
    }
    return tokens;
  }

  function calcPeek(state) {
    return state.tokens[state.pos] || null;
  }

  function calcHasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function calcCallFunc(name, args) {
    if (calcHasOwn(CALC_CONSTS, name)) {
      throw new CalcError(name + " 是常量，不能当作函数调用");
    }
    if (!calcHasOwn(CALC_FUNCS, name)) {
      throw new CalcError("未知函数：" + name);
    }
    var def = CALC_FUNCS[name];
    if (args.length < def.min || args.length > def.max) {
      var need = def.min === def.max ? String(def.min) : def.min + "~" + def.max;
      throw new CalcError("函数 " + name + " 需要 " + need + " 个参数，实际传入 " + args.length + " 个");
    }
    for (var i = 0; i < args.length; i += 1) {
      if (!isFinite(args[i])) throw new CalcError("函数 " + name + " 的参数不是有效数值");
    }
    var result;
    try {
      result = def.fn.apply(null, args);
    } catch (e) {
      if (e instanceof CalcError) throw e;
      throw new CalcError("函数 " + name + " 计算失败：" + errorText(e));
    }
    if (!isFinite(result)) {
      throw new CalcError("函数 " + name + " 的结果不是有效数值（可能超出定义域）");
    }
    return result;
  }

  function calcParsePrimary(state) {
    var token = calcPeek(state);
    if (!token) throw new CalcError("表达式不完整，缺少数字或括号");

    if (token.type === "num") {
      state.pos += 1;
      return token.value;
    }

    if (token.type === "(") {
      state.pos += 1;
      var inner = calcParseAddSub(state);
      var close = calcPeek(state);
      if (!close || close.type !== ")") throw new CalcError("括号不匹配，缺少右括号");
      state.pos += 1;
      return inner;
    }

    if (token.type === "ident") {
      state.pos += 1;
      var next = calcPeek(state);
      if (next && next.type === "(") {
        state.pos += 1;
        var args = [];
        if (calcPeek(state) && calcPeek(state).type === ")") {
          state.pos += 1;
        } else {
          for (;;) {
            args.push(calcParseAddSub(state));
            var sep = calcPeek(state);
            if (sep && sep.type === ",") {
              state.pos += 1;
              continue;
            }
            break;
          }
          var closeParen = calcPeek(state);
          if (!closeParen || closeParen.type !== ")") {
            throw new CalcError("函数 " + token.value + " 的括号不匹配");
          }
          state.pos += 1;
        }
        return calcCallFunc(token.value, args);
      }
      if (calcHasOwn(CALC_CONSTS, token.value)) return CALC_CONSTS[token.value];
      throw new CalcError("未知常量：" + token.value);
    }

    if (token.type === "op") throw new CalcError("运算符 " + token.value + " 缺少操作数");
    throw new CalcError("意外的符号：" + (token.value || token.type));
  }

  function calcParsePower(state) {
    var base = calcParsePrimary(state);
    var token = calcPeek(state);
    if (token && token.type === "op" && token.value === "^") {
      state.pos += 1;
      var exponent = calcParseUnary(state); // 右结合，且允许 2^-1
      var result = Math.pow(base, exponent);
      if (!isFinite(result)) throw new CalcError("幂运算结果无效（溢出或未定义）");
      return result;
    }
    return base;
  }

  function calcParseUnary(state) {
    var token = calcPeek(state);
    if (token && token.type === "op" && (token.value === "+" || token.value === "-")) {
      state.pos += 1;
      var value = calcParseUnary(state);
      return token.value === "-" ? -value : value;
    }
    return calcParsePower(state);
  }

  function calcParseMulDiv(state) {
    var value = calcParseUnary(state);
    for (;;) {
      var token = calcPeek(state);
      if (!token || token.type !== "op" || (token.value !== "*" && token.value !== "/" && token.value !== "%")) {
        break;
      }
      state.pos += 1;
      var right = calcParseUnary(state);
      if (token.value === "*") {
        value *= right;
      } else if (token.value === "%") {
        if (right === 0) throw new CalcError("取模的除数不能为零");
        value %= right;
      } else {
        if (right === 0) throw new CalcError("除数不能为零");
        value /= right;
      }
    }
    return value;
  }

  function calcParseAddSub(state) {
    var value = calcParseMulDiv(state);
    for (;;) {
      var token = calcPeek(state);
      if (!token || token.type !== "op" || (token.value !== "+" && token.value !== "-")) break;
      state.pos += 1;
      var right = calcParseMulDiv(state);
      value = token.value === "+" ? value + right : value - right;
    }
    return value;
  }

  function calcEvaluate(expression) {
    var raw = String(expression == null ? "" : expression).trim();
    if (!raw) throw new CalcError("表达式为空");
    if (raw.length > 500) throw new CalcError("表达式过长（最多 500 个字符）");
    var tokens = calcTokenize(raw);
    if (!tokens.length) throw new CalcError("表达式为空");
    var state = { tokens: tokens, pos: 0 };
    var value = calcParseAddSub(state);
    if (state.pos < tokens.length) {
      var rest = tokens[state.pos];
      throw new CalcError("无法解析的内容：" + (rest.value || rest.type));
    }
    if (!isFinite(value)) throw new CalcError("计算结果不是有效数值");
    return roundNumber(value, 12);
  }

  function calcCommandResult(args) {
    var text = argText(args);
    if (!text) return "用法：/calc <表达式>，例如 /calc (1+2)*3";
    try {
      return "计算结果：" + calcEvaluate(text);
    } catch (e) {
      return "计算出错：" + errorText(e);
    }
  }

  DSPlugins.register({
    id: "calculator",
    name: "计算器",
    version: "1.0.0",
    author: AUTHOR,
    description: "安全计算数学表达式（不使用 eval），支持 + - * / % ^、括号、小数、负数与 sqrt/abs/sin/cos/tan/log/ln 等函数。",
    builtin: true,
    commands: [
      {
        name: "calc",
        description: "计算数学表达式",
        usage: "/calc (1+2)*3",
        run: function (ctx, args) {
          return calcCommandResult(args);
        }
      }
    ],
    tools: [
      {
        name: "calculator",
        description:
          "计算数学表达式并返回结果。支持 + - * / % ^、括号、小数、负数，以及 sqrt/abs/sin/cos/tan/log/ln/round/floor/ceil 函数和 pi、e 常量。",
        parameters: {
          type: "object",
          properties: {
            expression: {
              type: "string",
              description: "要计算的数学表达式，例如 (1+2)*3 或 sqrt(16)+2^3"
            }
          },
          required: ["expression"]
        },
        run: async function (ctx, args) {
          var expression = args && typeof args.expression === "string" ? args.expression : "";
          if (!expression.trim()) return "计算出错：缺少 expression 参数";
          try {
            return "表达式 " + expression.trim() + " = " + calcEvaluate(expression);
          } catch (e) {
            return "计算出错：" + errorText(e);
          }
        }
      }
    ]
  });

  /* ================================================================== *
   * 插件 2：时间日期
   * ================================================================== */
  function resolveTimezone(timezone) {
    var tz = typeof timezone === "string" ? timezone.trim() : "";
    if (!tz) {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "本地时区";
      } catch (e) {
        return "本地时区";
      }
    }
    try {
      new Intl.DateTimeFormat("zh-CN", { timeZone: tz }); // 仅用于校验
      return tz;
    } catch (e2) {
      throw new Error("无效的时区：" + tz + "（请使用 IANA 时区名，如 Asia/Shanghai）");
    }
  }

  function formatTimeInfo(timezone) {
    var tz = resolveTimezone(timezone);
    var now = new Date();
    var dateText;
    var weekdayText;
    var clockText;
    var offsetText = "";
    try {
      dateText = new Intl.DateTimeFormat("zh-CN", {
        timeZone: tz,
        year: "numeric",
        month: "long",
        day: "numeric"
      }).format(now);
      weekdayText = new Intl.DateTimeFormat("zh-CN", { timeZone: tz, weekday: "long" }).format(now);
      clockText = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      }).format(now);
      try {
        var parts = new Intl.DateTimeFormat("en-US", {
          timeZone: tz,
          timeZoneName: "shortOffset"
        }).formatToParts(now);
        for (var i = 0; i < parts.length; i += 1) {
          if (parts[i].type === "timeZoneName") {
            offsetText = parts[i].value;
            break;
          }
        }
      } catch (e) {
        offsetText = "";
      }
    } catch (e2) {
      throw new Error("计算本地时间失败：" + errorText(e2));
    }
    return [
      "日期：" + dateText,
      "星期：" + weekdayText,
      "时间：" + clockText,
      "时区：" + tz + (offsetText ? "（" + offsetText + "）" : ""),
      "ISO 时间：" + now.toISOString()
    ].join("\n");
  }

  function parseDateInput(input) {
    var s = String(input == null ? "" : input).trim();
    if (!s) throw new Error("缺少目标时间，例如 2027-01-01T00:00:00+08:00");
    var ts = Date.parse(s);
    if (!isFinite(ts) && /\d{1,2}:\d{2}/.test(s)) {
      ts = Date.parse(s.replace(" ", "T"));
    }
    if (!isFinite(ts)) {
      throw new Error("无法解析目标时间：" + s + "（建议使用 2027-01-01T00:00:00+08:00 格式）");
    }
    return ts;
  }

  function countdownText(target) {
    var ts = parseDateInput(target);
    var diff = ts - Date.now();
    var future = diff >= 0;
    var abs = Math.abs(diff);
    var days = Math.floor(abs / 86400000);
    var hours = Math.floor((abs % 86400000) / 3600000);
    var minutes = Math.floor((abs % 3600000) / 60000);
    var seconds = Math.floor((abs % 60000) / 1000);
    var label = future ? "距离" : "距";
    var tail = future ? "还有" : "已过去";
    return (
      label +
      " " +
      new Date(ts).toISOString() +
      " " +
      tail +
      " " +
      days +
      " 天 " +
      hours +
      " 小时 " +
      minutes +
      " 分 " +
      seconds +
      " 秒"
    );
  }

  DSPlugins.register({
    id: "time",
    name: "时间日期",
    version: "1.0.0",
    author: AUTHOR,
    description: "查询当前日期、星期、时间与 IANA 时区，也可以计算距离某个时间点还有多久。",
    builtin: true,
    commands: [
      {
        name: "time",
        aliases: ["date"],
        description: "查看当前时间（可指定时区）",
        usage: "/time [Asia/Shanghai]",
        run: function (ctx, args) {
          var tz = argText(args) || undefined;
          try {
            return formatTimeInfo(tz);
          } catch (e) {
            return "获取时间失败：" + errorText(e);
          }
        }
      }
    ],
    tools: [
      {
        name: "current_time",
        description: "获取当前日期、星期、时间与所在时区。可传入 IANA 时区（如 Asia/Shanghai）查询指定时区的时间。",
        parameters: {
          type: "object",
          properties: {
            timezone: {
              type: "string",
              description: "IANA 时区名，例如 Asia/Shanghai、America/New_York；省略则使用设备时区"
            }
          },
          required: []
        },
        run: async function (ctx, args) {
          var tz = args && typeof args.timezone === "string" ? args.timezone : "";
          try {
            return formatTimeInfo(tz || undefined);
          } catch (e) {
            return "获取时间失败：" + errorText(e);
          }
        }
      },
      {
        name: "countdown",
        description: "计算距离指定时间点还有多久（或已经过去多久）。",
        parameters: {
          type: "object",
          properties: {
            target: {
              type: "string",
              description: "目标时间，ISO 格式或可被 Date.parse 解析，例如 2027-01-01T00:00:00+08:00"
            }
          },
          required: ["target"]
        },
        run: async function (ctx, args) {
          var target = args && typeof args.target === "string" ? args.target : "";
          if (!target.trim()) return "倒计时出错：缺少 target 参数";
          try {
            return countdownText(target);
          } catch (e) {
            return "倒计时出错：" + errorText(e);
          }
        }
      }
    ]
  });

  /* ================================================================== *
   * 插件 3：网页抓取（仅 https；http 仅 localhost / 127.0.0.1）
   * ================================================================== */
  var FETCH_MAX_CHARS = 4000;
  var FETCH_TIMEOUT_MS = 20000;

  function isLocalHostname(host) {
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  }

  function validateFetchUrl(raw) {
    var url = String(raw == null ? "" : raw).trim();
    if (!url) throw new Error("缺少 url 参数");
    var parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      throw new Error("无效的 URL：" + url);
    }
    var proto = String(parsed.protocol || "").toLowerCase();
    var host = String(parsed.hostname || "").toLowerCase();
    if (!(proto === "https:" || (proto === "http:" && isLocalHostname(host)))) {
      throw new Error("安全限制：只允许抓取 https 地址（http 仅限 localhost / 127.0.0.1）：" + url);
    }
    return parsed.href;
  }

  function decodeHtmlEntities(text) {
    var entityMap = {
      "&amp;": "&",
      "&lt;": "<",
      "&gt;": ">",
      "&quot;": '"',
      "&#39;": "'",
      "&apos;": "'",
      "&nbsp;": " "
    };
    return String(text).replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, function (m) {
      return entityMap[m] || m;
    });
  }

  function htmlToText(html) {
    var text = String(html);
    text = text.replace(/<script[\s\S]*?<\/script>/gi, " ");
    text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
    text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
    text = text.replace(/<!--[\s\S]*?-->/g, " ");
    text = text.replace(/<br\s*\/?>/gi, "\n");
    text = text.replace(/<\/(?:p|div|li|h[1-6]|tr|section|article|header|footer)>/gi, "\n");
    text = text.replace(/<[^>]+>/g, " ");
    text = decodeHtmlEntities(text);
    text = text.replace(/[ \t\u00a0]+/g, " ");
    text = text.replace(/\n\s*\n+/g, "\n\n");
    return text.trim();
  }

  function truncateFetchText(text) {
    var s = String(text);
    if (s.length <= FETCH_MAX_CHARS) return s;
    return s.slice(0, FETCH_MAX_CHARS) + "\n…（已截断，原文共 " + s.length + " 字符）";
  }

  async function fetchUrlText(ctx, rawUrl) {
    var url = validateFetchUrl(rawUrl);
    if (!ctx || !ctx.http || typeof ctx.http.fetch !== "function") {
      throw new Error("当前环境不支持网络请求");
    }
    var response;
    try {
      response = await ctx.http.fetch(url, {
        method: "GET",
        headers: { Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.8" },
        timeout: FETCH_TIMEOUT_MS
      });
    } catch (e) {
      throw new Error("抓取失败：" + errorText(e));
    }
    var status = response && typeof response.status === "number" ? response.status : 0;
    var body = response && typeof response.body === "string" ? response.body : "";
    if (!body && response && typeof response.text === "string") body = response.text;
    var text = body;
    if (/<html[\s>]|<body[\s>]|<!doctype html/i.test(text.slice(0, 2000))) {
      text = htmlToText(text);
    }
    var head = "HTTP " + status + (status >= 200 && status < 300 ? "（成功）" : "（非 2xx 状态）");
    return head + "\n" + truncateFetchText(text);
  }

  DSPlugins.register({
    id: "web",
    name: "网页抓取",
    version: "1.0.0",
    author: AUTHOR,
    description: "抓取网页或接口的文本内容（仅 https，localhost 例外），返回 HTTP 状态码与前 4000 字正文。",
    builtin: true,
    commands: [
      {
        name: "fetch",
        aliases: ["url"],
        description: "抓取网页并显示前 4000 字文本",
        usage: "/fetch https://example.com",
        run: async function (ctx, args) {
          var url = argText(args);
          if (!url) return "用法：/fetch <https://网址>";
          try {
            return await fetchUrlText(ctx, url);
          } catch (e) {
            return "抓取失败：" + errorText(e);
          }
        }
      }
    ],
    tools: [
      {
        name: "fetch_url",
        description:
          "抓取指定 URL 的文本内容（仅允许 https，http 仅限 localhost/127.0.0.1），返回 HTTP 状态码与前 4000 字正文，可用于阅读网页或调用 JSON 接口。",
        parameters: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "要抓取的完整 URL，必须以 https:// 开头（localhost 可用 http://）"
            }
          },
          required: ["url"]
        },
        run: async function (ctx, args) {
          var url = args && typeof args.url === "string" ? args.url : "";
          if (!url.trim()) return "抓取失败：缺少 url 参数";
          try {
            return await fetchUrlText(ctx, url);
          } catch (e) {
            return "抓取失败：" + errorText(e);
          }
        }
      }
    ]
  });

  /* ================================================================== *
   * 插件 4：提示词模板库（本地模板，无需网络）
   * ================================================================== */
  var PROMPT_TEMPLATES = {
    writing: {
      title: "写作",
      description: "围绕主题写一篇结构清晰的中文文章",
      template:
        "你是一位专业的中文写作助手。请以「{input}」为主题写一篇文章：先给出 3 个可选标题，再写正文，最后附 100 字以内的摘要。要求结构清晰、语言自然，避免空洞套话。"
    },
    translate: {
      title: "翻译",
      description: "中英互译，保留原意与语气",
      template:
        "请把下面的内容翻译成简体中文；如果原文已经是中文，则翻译成自然流畅的英文。保持原意、语气与专业术语，不要添加额外解释：\n\n{input}"
    },
    summarize: {
      title: "总结",
      description: "把长文压缩成要点摘要",
      template:
        "请阅读下面的内容，用中文总结：1）一句话结论；2）3~5 个要点；3）如果有行动项请单独列出。保持客观，不添加原文没有的信息：\n\n{input}"
    },
    explain_code: {
      title: "代码解释",
      description: "逐步解释一段代码",
      template:
        "请解释下面这段代码：1）整体作用；2）逐段说明关键逻辑；3）指出潜在 bug 或边界情况；4）给出可选的改进建议。用中文回答，必要时附简短示例代码：\n\n{input}"
    },
    rewrite: {
      title: "润色改写",
      description: "让文字更通顺、专业",
      template:
        "请润色下面这段文字：保持原意与事实不变，让表达更通顺、专业、适合正式场合。直接给出改写后的版本，再简要列出修改点：\n\n{input}"
    },
    email: {
      title: "邮件",
      description: "根据要点写一封正式邮件",
      template:
        "请根据以下要点写一封中文正式邮件，包含主题、称呼、正文与结尾落款。语气礼貌、简洁、目的明确：\n\n{input}"
    },
    plan: {
      title: "计划",
      description: "把目标拆解成可执行步骤",
      template:
        "请把下面的目标拆解成可执行计划：按阶段列出步骤、每步产出与预计耗时，并指出最大风险与应对办法。用中文回答：\n\n{input}"
    }
  };

  var PROMPT_KEYS = Object.keys(PROMPT_TEMPLATES);

  function promptPlaceholder(text) {
    return text && text.trim() ? text.trim() : "<在此粘贴你的内容>";
  }

  function renderPromptTemplate(key, input) {
    var item = PROMPT_TEMPLATES[key];
    if (!item) {
      throw new Error("未找到模板：" + key + "（可用：" + PROMPT_KEYS.join("、") + "）");
    }
    return item.template.split("{input}").join(promptPlaceholder(input));
  }

  function promptListText() {
    var lines = ["提示词模板库（/prompt <模板名> <你的内容>）："];
    for (var i = 0; i < PROMPT_KEYS.length; i += 1) {
      var key = PROMPT_KEYS[i];
      var item = PROMPT_TEMPLATES[key];
      lines.push("• " + key + "（" + item.title + "）：" + item.description);
    }
    lines.push("示例：/prompt translate 今天天气很好");
    return lines.join("\n");
  }

  DSPlugins.register({
    id: "prompts",
    name: "提示词模板库",
    version: "1.0.0",
    author: AUTHOR,
    description: "内置写作、翻译、总结、代码解释、润色、邮件、计划等提示词模板，本地运行无需网络。",
    builtin: true,
    commands: [
      {
        name: "prompt",
        aliases: ["tpl"],
        description: "查看或使用提示词模板",
        usage: "/prompt <模板名> <内容>",
        run: function (ctx, args) {
          var text = argText(args);
          if (!text) return promptListText();
          var spaceIndex = text.search(/\s/);
          var key = (spaceIndex < 0 ? text : text.slice(0, spaceIndex)).toLowerCase();
          var input = spaceIndex < 0 ? "" : text.slice(spaceIndex + 1);
          if (!PROMPT_TEMPLATES[key]) {
            return "未找到模板：" + key + "\n\n" + promptListText();
          }
          try {
            return "已生成提示词（可直接发送给模型）：\n\n" + renderPromptTemplate(key, input);
          } catch (e) {
            return "生成提示词失败：" + errorText(e);
          }
        }
      }
    ],
    tools: [
      {
        name: "use_prompt_template",
        description:
          "使用内置提示词模板生成一段可直接使用的提示词。可用模板：writing（写作）、translate（翻译）、summarize（总结）、explain_code（代码解释）、rewrite（润色改写）、email（邮件）、plan（计划拆解）。",
        parameters: {
          type: "object",
          properties: {
            template: {
              type: "string",
              description: "模板名",
              enum: PROMPT_KEYS
            },
            input: {
              type: "string",
              description: "要放进模板的内容，例如要翻译或总结的文字"
            }
          },
          required: ["template"]
        },
        run: async function (ctx, args) {
          var key = args && typeof args.template === "string" ? args.template.trim().toLowerCase() : "";
          if (!key) return "生成提示词失败：缺少 template 参数（可用：" + PROMPT_KEYS.join("、") + "）";
          try {
            return "提示词模板 " + key + "：\n\n" + renderPromptTemplate(key, args && args.input);
          } catch (e) {
            return "生成提示词失败：" + errorText(e);
          }
        }
      }
    ]
  });

  /* ================================================================== *
   * 插件 5：随机数与骰子
   * ================================================================== */
  function randomInt(min, max) {
    var lo = Math.ceil(min);
    var hi = Math.floor(max);
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  }

  function parseDiceSpec(spec) {
    var s = String(spec == null ? "" : spec).trim().toLowerCase();
    if (!s) return { count: 1, sides: 6 };
    var m = /^(\d{1,2})?d(\d{1,4})$/.exec(s);
    if (m) {
      return { count: m[1] ? Number(m[1]) : 1, sides: Number(m[2]) };
    }
    if (/^\d{1,4}$/.test(s)) return { count: 1, sides: Number(s) };
    throw new Error("无法识别的骰子格式：" + s + "（示例：/roll 2d6）");
  }

  function validateDice(count, sides) {
    if (!Number.isInteger(count) || count < 1 || count > 20) {
      throw new Error("骰子数量必须是 1~20 的整数");
    }
    if (!Number.isInteger(sides) || sides < 2 || sides > 1000) {
      throw new Error("骰子面数必须是 2~1000 的整数");
    }
  }

  function rollDiceText(count, sides) {
    validateDice(count, sides);
    var results = [];
    var total = 0;
    for (var i = 0; i < count; i += 1) {
      var n = randomInt(1, sides);
      results.push(n);
      total += n;
    }
    var detail = count > 1 ? "（" + results.join(" + ") + "）" : "";
    return "🎲 掷 " + count + "d" + sides + "：" + total + " " + detail;
  }

  function randomNumberText(min, max) {
    var lo = Number(min);
    var hi = Number(max);
    if (!isFinite(lo) || !isFinite(hi)) throw new Error("min 与 max 必须是数字");
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error("min 与 max 必须是整数");
    if (lo > hi) throw new Error("min 不能大于 max");
    if (hi - lo > 1000000) throw new Error("随机范围过大（最多 1000000）");
    return "🎲 随机数 [" + lo + ", " + hi + "]：" + randomInt(lo, hi);
  }

  DSPlugins.register({
    id: "random",
    name: "随机数与骰子",
    version: "1.0.0",
    author: AUTHOR,
    description: "掷骰子（NdM）与生成指定范围内的随机整数，可用于抽签、游戏与做决定。",
    builtin: true,
    commands: [
      {
        name: "roll",
        description: "掷骰子，例如 /roll 2d6",
        usage: "/roll [NdM]",
        run: function (ctx, args) {
          var text = argText(args);
          try {
            var spec = parseDiceSpec(text);
            return rollDiceText(spec.count, spec.sides);
          } catch (e) {
            return "掷骰子失败：" + errorText(e);
          }
        }
      },
      {
        name: "random",
        description: "生成指定范围内的随机整数，例如 /random 1 100",
        usage: "/random [min] [max]",
        run: function (ctx, args) {
          var text = argText(args);
          var parts = text ? text.split(/\s+/) : [];
          var min = parts.length >= 1 ? Number(parts[0]) : 1;
          var max = parts.length >= 2 ? Number(parts[1]) : 100;
          try {
            return randomNumberText(min, max);
          } catch (e) {
            return "生成随机数失败：" + errorText(e);
          }
        }
      }
    ],
    tools: [
      {
        name: "roll_dice",
        description: "掷骰子并返回点数总和，可指定骰子数量与面数。",
        parameters: {
          type: "object",
          properties: {
            count: { type: "integer", description: "骰子数量，1~20，默认 1" },
            sides: { type: "integer", description: "每个骰子的面数，2~1000，默认 6" }
          },
          required: []
        },
        run: async function (ctx, args) {
          var count = args && args.count != null ? Number(args.count) : 1;
          var sides = args && args.sides != null ? Number(args.sides) : 6;
          try {
            return rollDiceText(count, sides);
          } catch (e) {
            return "掷骰子失败：" + errorText(e);
          }
        }
      },
      {
        name: "random_number",
        description: "生成指定闭区间内的随机整数。",
        parameters: {
          type: "object",
          properties: {
            min: { type: "integer", description: "最小值（含）" },
            max: { type: "integer", description: "最大值（含）" }
          },
          required: ["min", "max"]
        },
        run: async function (ctx, args) {
          var min = args && args.min != null ? Number(args.min) : NaN;
          var max = args && args.max != null ? Number(args.max) : NaN;
          try {
            return randomNumberText(min, max);
          } catch (e) {
            return "生成随机数失败：" + errorText(e);
          }
        }
      }
    ]
  });

  /* ================================================================== *
   * 插件 6：单位换算
   * ================================================================== */
  var UNIT_ALIASES = {
    "米": "m",
    "公里": "km",
    "千米": "km",
    "厘米": "cm",
    "毫米": "mm",
    "英里": "mi",
    "英尺": "ft",
    "英寸": "in",
    "码": "yd",
    "千克": "kg",
    "公斤": "kg",
    "克": "g",
    "吨": "t",
    "磅": "lb",
    "盎司": "oz",
    "升": "l",
    "毫升": "ml",
    "加仑": "gal",
    "秒": "s",
    "分钟": "min",
    "小时": "h",
    "天": "day",
    "字节": "b",
    "摄氏度": "c",
    "华氏度": "f",
    "开尔文": "k"
  };

  var UNIT_CATEGORIES = {
    length: { units: { m: 1, km: 1000, cm: 0.01, mm: 0.001, mi: 1609.344, ft: 0.3048, in: 0.0254, yd: 0.9144 } },
    mass: { units: { kg: 1, g: 0.001, t: 1000, lb: 0.45359237, oz: 0.028349523125 } },
    volume: { units: { l: 1, ml: 0.001, m3: 1000, gal: 3.785411784 } },
    time: { units: { s: 1, min: 60, h: 3600, day: 86400 } },
    data: { units: { b: 1, kb: 1024, mb: 1048576, gb: 1073741824 } }
  };

  var UNIT_SUPPORT_TEXT =
    "支持：长度 m/km/cm/mm/mi/ft/in、质量 kg/g/t/lb/oz、温度 c/f/k、体积 l/ml/m3/gal、时间 s/min/h/day、数据 b/kb/mb/gb";

  function normalizeUnit(unit) {
    var key = String(unit == null ? "" : unit).trim().toLowerCase();
    if (!key) throw new Error("单位不能为空");
    if (UNIT_ALIASES[key]) return UNIT_ALIASES[key];
    return key;
  }

  function temperatureToKelvin(value, unit) {
    if (unit === "c") return value + 273.15;
    if (unit === "f") return ((value - 32) * 5) / 9 + 273.15;
    if (unit === "k") return value;
    throw new Error("不支持的温度单位：" + unit);
  }

  function temperatureFromKelvin(kelvin, unit) {
    if (unit === "c") return kelvin - 273.15;
    if (unit === "f") return ((kelvin - 273.15) * 9) / 5 + 32;
    if (unit === "k") return kelvin;
    throw new Error("不支持的温度单位：" + unit);
  }

  function unitCategoryOf(unit) {
    var categories = Object.keys(UNIT_CATEGORIES);
    for (var i = 0; i < categories.length; i += 1) {
      if (Object.prototype.hasOwnProperty.call(UNIT_CATEGORIES[categories[i]].units, unit)) {
        return categories[i];
      }
    }
    if (unit === "c" || unit === "f" || unit === "k") return "temperature";
    return null;
  }

  function convertUnits(value, fromRaw, toRaw) {
    var amount = Number(value);
    if (!isFinite(amount)) throw new Error("数值无效：" + value);
    var from = normalizeUnit(fromRaw);
    var to = normalizeUnit(toRaw);
    var fromCat = unitCategoryOf(from);
    var toCat = unitCategoryOf(to);
    if (!fromCat) throw new Error("不支持的单位：" + fromRaw + "\n" + UNIT_SUPPORT_TEXT);
    if (!toCat) throw new Error("不支持的单位：" + toRaw + "\n" + UNIT_SUPPORT_TEXT);
    if (fromCat !== toCat) {
      throw new Error("不能在不同类别之间换算：" + fromRaw + " → " + toRaw + "\n" + UNIT_SUPPORT_TEXT);
    }
    var result;
    if (fromCat === "temperature") {
      result = temperatureFromKelvin(temperatureToKelvin(amount, from), to);
    } else {
      var units = UNIT_CATEGORIES[fromCat].units;
      result = (amount * units[from]) / units[to];
    }
    if (!isFinite(result)) throw new Error("换算结果无效（溢出）");
    return roundNumber(result, 10);
  }

  function unitCommandResult(args) {
    var text = argText(args);
    if (!text) return "用法：/convert <数值> <原单位> <目标单位>，例如 /convert 12 km mi";
    var parts = text.split(/\s+/);
    if (parts.length < 3) return "用法：/convert <数值> <原单位> <目标单位>，例如 /convert 12 km mi";
    try {
      var result = convertUnits(parts[0], parts[1], parts[2]);
      return parts[0] + " " + parts[1] + " = " + result + " " + parts[2];
    } catch (e) {
      return "换算失败：" + errorText(e);
    }
  }

  DSPlugins.register({
    id: "units",
    name: "单位换算",
    version: "1.0.0",
    author: AUTHOR,
    description: "长度、质量、温度、体积、时间、数据等常见单位的换算（本地计算，无需网络）。",
    builtin: true,
    commands: [
      {
        name: "convert",
        aliases: ["conv"],
        description: "单位换算，例如 /convert 12 km mi",
        usage: "/convert <数值> <原单位> <目标单位>",
        run: function (ctx, args) {
          return unitCommandResult(args);
        }
      }
    ],
    tools: [
      {
        name: "convert_units",
        description:
          "换算常见单位，支持长度（m/km/cm/mm/mi/ft/in）、质量（kg/g/t/lb/oz）、温度（c/f/k）、体积（l/ml/m3/gal）、时间（s/min/h/day）、数据（b/kb/mb/gb）。",
        parameters: {
          type: "object",
          properties: {
            value: { type: "number", description: "要换算的数值" },
            from: { type: "string", description: "原单位，例如 km" },
            to: { type: "string", description: "目标单位，例如 mi" }
          },
          required: ["value", "from", "to"]
        },
        run: async function (ctx, args) {
          if (!args || args.value == null || args.from == null || args.to == null) {
            return "换算失败：缺少 value / from / to 参数";
          }
          try {
            var result = convertUnits(args.value, args.from, args.to);
            return args.value + " " + args.from + " = " + result + " " + args.to;
          } catch (e) {
            return "换算失败：" + errorText(e);
          }
        }
      }
    ]
  });
})(typeof window !== "undefined" ? window : globalThis);
