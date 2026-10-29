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

    /** 注册（同 id 覆盖）。key 使用 {@link ToolDef#id()}。 */
    public void register(ToolDef def) {
        if (def == null) {
            return;
        }
        synchronized (lock) {
            tools.put(def.id(), def);
        }
    }

    /** 注销（按 id 优先，其次按 OpenAI function 名），返回是否真的移除了。 */
    public boolean unregister(String idOrName) {
        if (idOrName == null) {
            return false;
        }
        String key = idOrName.trim();
        synchronized (lock) {
            if (tools.remove(key) != null) {
                return true;
            }
            java.util.Iterator<Map.Entry<String, ToolDef>> iterator = tools.entrySet().iterator();
            while (iterator.hasNext()) {
                Map.Entry<String, ToolDef> entry = iterator.next();
                if (entry.getValue().name().equals(key)) {
                    iterator.remove();
                    return true;
                }
            }
            return false;
        }
    }

    /** 查找：先按 id，再按 OpenAI function 名（MCP 工具的 OpenAI 名与 id 不同）。 */
    public ToolDef find(String idOrName) {
        if (idOrName == null) {
            return null;
        }
        String key = idOrName.trim();
        synchronized (lock) {
            ToolDef def = tools.get(key);
            if (def != null) {
                return def;
            }
            for (ToolDef item : tools.values()) {
                if (item.name().equals(key)) {
                    return item;
                }
            }
            return null;
        }
    }

    /** 注销某个 MCP 服务器的全部远程工具（断开/重连前调用），返回移除数量。 */
    public int removeRemote(String serverId) {
        if (serverId == null || serverId.trim().isEmpty()) {
            return 0;
        }
        String target = serverId.trim();
        int removed = 0;
        synchronized (lock) {
            java.util.Iterator<Map.Entry<String, ToolDef>> iterator = tools.entrySet().iterator();
            while (iterator.hasNext()) {
                Map.Entry<String, ToolDef> entry = iterator.next();
                if (target.equals(entry.getValue().remote())) {
                    iterator.remove();
                    removed++;
                }
            }
        }
        return removed;
    }

    /** 注销所有远程（MCP）工具，返回移除数量（manager shutdown 兜底用）。 */
    public int clearRemote() {
        int removed = 0;
        synchronized (lock) {
            java.util.Iterator<Map.Entry<String, ToolDef>> iterator = tools.entrySet().iterator();
            while (iterator.hasNext()) {
                Map.Entry<String, ToolDef> entry = iterator.next();
                if (!entry.getValue().remote().isEmpty()) {
                    iterator.remove();
                    removed++;
                }
            }
        }
        return removed;
    }

    /** 某个 MCP 服务器已注册的工具快照。 */
    public List<ToolDef> remoteTools(String serverId) {
        List<ToolDef> result = new ArrayList<>();
        if (serverId == null) {
            return result;
        }
        String target = serverId.trim();
        synchronized (lock) {
            for (ToolDef def : tools.values()) {
                if (target.equals(def.remote())) {
                    result.add(def);
                }
            }
        }
        return result;
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
