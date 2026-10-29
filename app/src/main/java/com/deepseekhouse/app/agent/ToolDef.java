package com.deepseekhouse.app.agent;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * 单个原生工具的定义（SPEC「ARCH v2 P1」N1）。
 *
 * <p>字段与 OpenAI function calling 的 tools 数组一一对应，另加本地风控信息：</p>
 * <ul>
 *   <li>{@link Risk#LOW}：只读/低风险，直接执行；</li>
 *   <li>{@link Risk#MID}：有副作用（如写文件），同一 App 会话内首次执行前确认一次；</li>
 *   <li>{@link Risk#HIGH}：高危（如 shell），每次执行都必须确认。</li>
 * </ul>
 *
 * <p>{@code needConfirm} 是工具作者声明的“默认是否需要确认”，最终是否弹确认框由
 * {@link Risk} 决定（见 {@code JsBridge#execTool}），LOW 永远不会弹框。</p>
 */
public final class ToolDef {

    /** 工具风险等级。JS 事件里用大写值（low/mid/high）。 */
    public enum Risk {
        LOW,
        MID,
        HIGH;

        /** 事件里使用的稳定小写名字。 */
        public String wireName() {
            return name().toLowerCase(java.util.Locale.US);
        }

        /** 解析不区分大小写，非法值按 HIGH 处理（宁严勿松）。 */
        public static Risk parse(String raw) {
            if (raw != null) {
                String v = raw.trim();
                for (Risk r : values()) {
                    if (r.name().equalsIgnoreCase(v)) {
                        return r;
                    }
                }
            }
            return HIGH;
        }
    }

    private final String name;
    private final String description;
    private final String parametersJson;
    private final Risk risk;
    private final boolean needConfirm;

    public ToolDef(String name, String description, String parametersJson,
                   Risk risk, boolean needConfirm) {
        String n = name == null ? "" : name.trim();
        if (n.isEmpty()) {
            throw new IllegalArgumentException("工具名不能为空");
        }
        this.name = n;
        this.description = description == null ? "" : description;
        String params = parametersJson == null ? "" : parametersJson.trim();
        this.parametersJson = params.isEmpty()
                ? "{\"type\":\"object\",\"properties\":{}}"
                : params;
        this.risk = risk == null ? Risk.HIGH : risk;
        this.needConfirm = needConfirm;
    }

    public String name() {
        return name;
    }

    public String description() {
        return description;
    }

    public String parametersJson() {
        return parametersJson;
    }

    /** 解析后的参数 JSON Schema；解析失败时退化为空 object schema。 */
    public JSONObject parameters() {
        try {
            return new JSONObject(parametersJson);
        } catch (JSONException e) {
            return new JSONObject();
        }
    }

    public Risk risk() {
        return risk;
    }

    public boolean needConfirm() {
        return needConfirm;
    }

    /** OpenAI tools 数组里的一项：{@code {"type":"function","function":{...}}}。 */
    public JSONObject toOpenAiJson() throws JSONException {
        JSONObject function = new JSONObject();
        function.put("name", name);
        function.put("description", description);
        function.put("parameters", parameters());
        JSONObject tool = new JSONObject();
        tool.put("type", "function");
        tool.put("function", function);
        return tool;
    }

    @Override
    public String toString() {
        return "ToolDef{" + name + ", risk=" + risk.wireName() + ", needConfirm=" + needConfirm + "}";
    }
}
