package com.deepseekhouse.app.agent;

import org.json.JSONArray;
import org.json.JSONException;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 原生工具注册表（单例）：内置工具在 App 启动时注册，插件/后续批次可继续 {@link #register}。
 *
 * <p>线程安全：所有读写都同步在同一把锁上；工具执行频率很低，无需更高并发度。</p>
 */
public final class ToolRegistry {

    private static final ToolRegistry INSTANCE = new ToolRegistry();

    private final Map<String, ToolDef> tools = new LinkedHashMap<>();
    private final Object lock = new Object();

    private ToolRegistry() {
    }

    public static ToolRegistry getInstance() {
        return INSTANCE;
    }

    /** 注册（同名覆盖）。 */
    public void register(ToolDef def) {
        if (def == null) {
            return;
        }
        synchronized (lock) {
            tools.put(def.name(), def);
        }
    }

    /** 注销，返回是否真的移除了。 */
    public boolean unregister(String name) {
        if (name == null) {
            return false;
        }
        synchronized (lock) {
            return tools.remove(name.trim()) != null;
        }
    }

    public ToolDef find(String name) {
        if (name == null) {
            return null;
        }
        synchronized (lock) {
            return tools.get(name.trim());
        }
    }

    public boolean contains(String name) {
        return find(name) != null;
    }

    public int size() {
        synchronized (lock) {
            return tools.size();
        }
    }

    /** 当前全部工具的快照（按注册顺序）。 */
    public List<ToolDef> all() {
        synchronized (lock) {
            return new ArrayList<>(tools.values());
        }
    }

    /** 只清空本进程注册的工具（测试/重载用）。 */
    public void clear() {
        synchronized (lock) {
            tools.clear();
        }
    }

    /**
     * 生成 OpenAI tools 数组 JSON（SPEC N1）：{@code [{"type":"function","function":{...}}]}。
     * 任何异常都返回 {@code "[]"}，JS 侧永不抛异常。
     */
    public String schemasJson() {
        JSONArray array = new JSONArray();
        try {
            for (ToolDef def : all()) {
                array.put(def.toOpenAiJson());
            }
        } catch (JSONException e) {
            return "[]";
        } catch (Throwable t) {
            return "[]";
        }
        return array.toString();
    }
}
