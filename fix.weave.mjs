import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(__dirname, 'server.js');
if (!fs.existsSync(file)) { console.log('ℹ️ server.js not found'); process.exit(0); }

let src = fs.readFileSync(file, 'utf8');
let changed = false;

// التعديل 1: حقن منطق المفتاح الخام في أول دالة resolveWeaveV3PlainKey
const fnStart = 'async function resolveWeaveV3PlainKey({ keyBuf, keySeed, iv, sampleEncrypted, ticket, logTag = "weave-v3" }) {';
if (src.includes(fnStart) && !src.includes('raw 16-byte key detected')) {
  const inject = fnStart + `
  if (keyBuf && Buffer.isBuffer(keyBuf) && keyBuf.length === 16) {
    console.log(\`[\${logTag}] raw 16-byte key detected\`);
    const rawKey = Buffer.from(keyBuf);
    const ivs = [];
    if (iv && Buffer.isBuffer(iv) && iv.length === 16) ivs.push({ iv, tag: "playlist" });
    for (let s = 0; s < 4; s++) ivs.push({ iv: ivFromMediaSequence(s), tag: \`seq\${s}\` });
    ivs.push({ iv: Buffer.alloc(16, 0), tag: "zero" });
    if (!sampleEncrypted || sampleEncrypted.length < 32) return { key: rawKey, mode: "cbc", ivMode: "playlist", tag: "raw-16" };
    for (const { iv: ti, tag: it } of ivs) {
      try { if (looksLikeMpegTs(decryptSegment(sampleEncrypted, rawKey, ti), true)) return { key: rawKey, mode: "cbc", ivMode: it.startsWith("seq") ? "seq" : "playlist", tag: "raw-16" }; } catch {}
    }
    for (const { iv: ti, tag: it } of ivs) {
      try { if (looksLikeMpegTs(decryptSegmentCtr(sampleEncrypted, rawKey, ti), true)) return { key: rawKey, mode: "ctr", ivMode: it.startsWith("seq") ? "seq" : "playlist", tag: "raw-16" }; } catch {}
    }
    return { key: rawKey, mode: "cbc", ivMode: "playlist", tag: "raw-16-fallback" };
  }`;
  src = src.replace(fnStart, inject);
  changed = true;
  console.log('✅ [fix-weave] injected raw-key handling');
} else {
  console.log('ℹ️ [fix-weave] resolveWeaveV3PlainKey not found or already patched');
}

// التعديل 2: إلغاء passThrough القسري
const old2 = 'src.passThroughEncrypt = true;';
if (src.includes(old2) && !src.includes('passThrough=\${src.passThroughEncrypt}')) {
  src = src.replace(old2, `const keyOk = src.plainKey && !src._keyUnverified && !src._softAccepted;
    src.passThroughEncrypt = !keyOk;
    console.log(\`[weave-v3] passThrough=\${src.passThroughEncrypt}\`);`);
  changed = true;
  console.log('✅ [fix-weave] patched passThrough logic');
} else {
  console.log('ℹ️ [fix-weave] passThrough not found or already patched');
}

// التعديل 3: وسم المفاتيح soft
const old3 = 'src.ivMode = resolved.ivMode || "playlist";';
if (src.includes(old3) && !src.includes('_softAccepted = true')) {
  src = src.replace(old3, `src.ivMode = resolved.ivMode || "playlist";
        if (String(resolved.tag || "").includes("soft") || String(resolved.tag || "").includes("fallback")) { src._keyUnverified = true; src._softAccepted = true; }`);
  changed = true;
  console.log('✅ [fix-weave] patched soft key tagging');
} else {
  console.log('ℹ️ [fix-weave] ivMode line not found or already patched');
}

if (changed) {
  fs.writeFileSync(file, src, 'utf8');
  console.log('🎉 [fix-weave] server.js updated');
} else {
  console.log('ℹ️ [fix-weave] no changes needed');
}
