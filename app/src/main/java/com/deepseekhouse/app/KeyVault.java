package com.deepseekhouse.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.security.Key;
import java.security.KeyStore;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * F9 本地加密密钥：Android Keystore 里的 AES 密钥包裹 32 字节随机 secret。
 *
 * <p>JS 侧（Store）拿到 {@code getStorageSecret()} 的 Base64 明文后用 WebCrypto AES-GCM 加密
 * localStorage 状态；secret 本身不落盘，落盘的是 Keystore 包裹后的密文。
 * 任何失败（无 Keystore / 解包失败）都返回空串，JS 自动回退明文存储。</p>
 *
 * <p>解包失败时不重新生成：旧 secret 丢了再换新会让已加密的历史数据无法解读，
 * 因此归还 ""，让 JS 回退到明文（旧键保留），与 SPEC F9「加密失败不得丢数据」一致。</p>
 */
public final class KeyVault {

    private static final String SP_FILE = "dsh_secure";
    private static final String KEY_WRAPPED_SECRET = "storageSecretWrapped";
    private static final String KEYSTORE_PROVIDER = "AndroidKeyStore";
    private static final String KEY_ALIAS = "dsh_storage_secret_wrap_v1";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";

    private static final int SECRET_BYTES = 32;
    private static final int GCM_IV_BYTES = 12;
    private static final int GCM_TAG_BITS = 128;

    private KeyVault() {
    }

    /**
     * 返回 32 字节随机密钥的 Base64（无换行）；首次调用生成并包裹存储，之后解包返回同一密钥。
     * 失败/无法恢复返回 ""。
     */
    public static synchronized String getOrCreateSecret(Context context) {
        if (context == null) {
            return "";
        }
        Context app = context.getApplicationContext();
        SharedPreferences sp;
        try {
            sp = app.getSharedPreferences(SP_FILE, Context.MODE_PRIVATE);
        } catch (Throwable t) {
            return "";
        }
        String wrapped = null;
        try {
            wrapped = sp.getString(KEY_WRAPPED_SECRET, "");
        } catch (Throwable ignored) {
            wrapped = "";
        }
        if (wrapped != null && !wrapped.isEmpty()) {
            try {
                byte[] secret = unwrap(wrapped);
                if (secret != null && secret.length == SECRET_BYTES) {
                    return Base64.encodeToString(secret, Base64.NO_WRAP);
                }
            } catch (Throwable ignored) {
                // 落到下面返回 ""
            }
            return "";
        }
        try {
            byte[] secret = new byte[SECRET_BYTES];
            new SecureRandom().nextBytes(secret);
            String text = wrap(secret);
            if (text == null || text.isEmpty()) {
                return "";
            }
            // 用 commit：确保 secret 已落盘后再让 JS 用它加密数据，避免崩溃导致密文无法解密
            if (sp.edit().putString(KEY_WRAPPED_SECRET, text).commit()) {
                return Base64.encodeToString(secret, Base64.NO_WRAP);
            }
            return "";
        } catch (Throwable t) {
            return "";
        }
    }

    // ------------------------------------------------------------ 包裹 / 解包

    private static String wrap(byte[] secret) throws Exception {
        SecretKey key = getOrCreateWrappingKey();
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] iv = cipher.getIV();
        if (iv == null || iv.length == 0) {
            iv = new byte[GCM_IV_BYTES];
            new SecureRandom().nextBytes(iv);
            cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_BITS, iv));
        }
        byte[] cipherText = cipher.doFinal(secret);
        byte[] out = new byte[iv.length + cipherText.length];
        System.arraycopy(iv, 0, out, 0, iv.length);
        System.arraycopy(cipherText, 0, out, iv.length, cipherText.length);
        return Base64.encodeToString(out, Base64.NO_WRAP);
    }

    private static byte[] unwrap(String wrapped) throws Exception {
        byte[] all = Base64.decode(wrapped, Base64.NO_WRAP);
        if (all == null || all.length <= GCM_IV_BYTES) {
            throw new IllegalArgumentException("包裹数据不合法");
        }
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateWrappingKey(),
                new GCMParameterSpec(GCM_TAG_BITS, all, 0, GCM_IV_BYTES));
        return cipher.doFinal(all, GCM_IV_BYTES, all.length - GCM_IV_BYTES);
    }

    private static SecretKey getOrCreateWrappingKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER);
        keyStore.load(null);
        Key existing = keyStore.getKey(KEY_ALIAS, null);
        if (existing instanceof SecretKey) {
            return (SecretKey) existing;
        }
        try {
            return generateKey(256);
        } catch (Throwable t) {
            // 个别设备不支持 AES-256 in Keystore，退回 128
            return generateKey(128);
        }
    }

    private static SecretKey generateKey(int keySize) throws Exception {
        KeyGenerator generator = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER);
        KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
                KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(keySize)
                .setRandomizedEncryptionRequired(true)
                .build();
        generator.init(spec);
        return generator.generateKey();
    }
}
