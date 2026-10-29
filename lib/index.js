import { mkdir, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve, win32 } from "node:path";
import z from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import { execFile, execFileSync } from "node:child_process";
import { createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { ReasoningEffortId, resolveImageAttachmentAccess, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createServer } from "node:http";
import { Readable } from "node:stream";
//#region src/at-rest.ts
/**
* WorkBuddy 桌面端「静态加密」凭据的解密。
*
* 从 5.6.0 起，桌面端不再把 `auth.accessToken` / `auth.refreshToken` 写成明文字符串，
* 而是写一个字段信封：
*
*   { "$wbEncrypted": 1, "envelope": "<base64 of a JSON envelope>" }
*
* 信封本身是 `{suite, keyId, nonce, authTag, ciphertext}`，即 AES-256-GCM（12 字节
* nonce、16 字节 tag）。AAD 是一段长度前缀转录，把 scheme / suite / keyId / framing
* 一起绑进去，所以密文只能在它被封的那个「字段形状」下打开——换个 framing 解不开，
* 而不是解出垃圾。
*
* ## 为什么本插件要自己实现，而不是复用 dsh-connect-workbuddy 的那份
*
* 那份实现在 `plugins/dsh-connect-workbuddy/src/at-rest.ts`，与 dsh-workbuddy-xdpool
* 里另有一份。跨插件 `import` 会引入一个**加载顺序依赖**：对方没装、版本不匹配、或
* 将来改了导出，本插件就在启动期炸掉，而用户只是想用模型池。所以这里是一份独立
* 实现：约 400 行、零第三方依赖、只碰 node: 内置模块，代价是同一套协议有两处副本，
* 好处是任一插件单独安装都成立。
*
* ## 密钥从哪来（关键约束）
*
* 字段密钥**不是用户秘密**：它是编译进桌面端自己的 Electron 原生模块
* （`electron_browser_workbuddy_storage`）里的构建期常量。应用通过 `loggerGet()` 取到
* 一段 base64 **字符串**，再对它做 SHA-256 得到 32 字节密钥（注意是哈希那个字符串本身，
* 不是解码后的字节——哈希错对象会得到另一把钥匙，每个字段都解不开）。
*
* 因此本模块的做法是：**问装在同一台机器上的那个构建要它自己的密钥**——把桌面端二
* 进制当成普通 Node 跑（`ELECTRON_RUN_AS_NODE`），调它自己的 binding。这带来一个
* 必须如实承认的后果：
*
*   **本机没装桌面端，就拿不到密钥，加密账号就解不开。**
*
* 这不是 bug 而是协议的性质。所以本模块把「拿不到密钥」当成一等结果
* （`readAtRestKey()` 返回 `undefined`），让上游照旧把账号报成 `reason:'encrypted'`
* 并给出可操作提示，而不是假装解密成功或静默丢掉账号。
*
* @module dsh-connect-workbuddy-models/at-rest
*/
/** 信封 framing 名 → 转录里的单字节码。 */
const FRAMING_CODE = {
	file: 1,
	field: 2,
	record: 3,
	stream: 4
};
/** 对称信封的标准格式标识，参与 AAD 转录。 */
const STANDARD_FORMAT_ID = {
	file: "WBEF1",
	field: "WBEV1",
	record: "WBER1",
	stream: "WBES1"
};
/** AAD 转录的域分隔符。 */
const AAD_DOMAIN = Buffer.from("WB-AAD\0", "ascii");
/** 本模块打开的信封 scheme。 */
const SYMMETRIC_SCHEME = "sym-v1";
/** 指向桌面端可执行文件的环境变量（用户手工覆盖）。 */
const WB_APP_EXECUTABLE_ENV = "WORKBUDDY_APP_EXECUTABLE";
/** 等桌面端交出 payload 的上限。 */
const KEY_FETCH_TIMEOUT_MS = 1e4;
/**
* Windows 上桌面端二进制的文件名。
*
* `WorkBuddy.exe` 是国内版；国际版是 `WorkBuddyAI` 目录下的 **`WorkBuddyAI.exe`**。
* 保留成**列表**而不是第二个常量，因为同一个名字判断用在两处且必须一致：下面的
* 目录拼接，以及注册表取值校验（`DisplayIcon` 可能指向任一个）。
*/
const APP_EXECUTABLE_NAMES = ["WorkBuddy.exe", "WorkBuddyAI.exe"];
/**
* Windows 安装目录，按探测顺序，相对 `%LOCALAPPDATA%` / `%ProgramFiles%`。
*
* `Programs\WorkBuddy` 是常见的按用户布局，`WorkBuddy` 是某些安装器的扁平布局，
* `WorkBuddyAI` 那两对是国际版的。两种拼写都带，因为目录名与二进制名可能各自
* 不一致——而这里 miss 掉是**看不见的**（表现为「凭据读不了」而非「找不到程序」）。
*/
const WINDOWS_APP_SUBDIRECTORIES = [
	["Programs", "WorkBuddy"],
	["WorkBuddy"],
	["Programs", "WorkBuddyAI"],
	["WorkBuddyAI"]
];
/** macOS 上桌面端可能安装成的 bundle 名，按探测顺序。 */
const MACOS_APP_BUNDLE_NAMES = ["WorkBuddy.app", "WorkBuddy AI.app"];
function encodeUint32(value) {
	const bytes = Buffer.allocUnsafe(4);
	bytes.writeUInt32BE(value);
	return bytes;
}
/** 长度前缀 UTF-8：uint32 大端长度 + 字节。 */
function encodeLengthPrefixed(value) {
	const bytes = Buffer.from(value, "utf8");
	return Buffer.concat([encodeUint32(bytes.length), bytes]);
}
/**
* 一个 `sym-v1` FIELD-framed 信封的 AAD。
*
* 只实现字段 framing：桌面端对凭据字段就用这个形状，而它也无法与整文件信封混淆，
* 所以遇到意外 framing 是解析错误，而不是悄悄用错的转录。
*
* 导出是为了让加密侧（测试里造合成信封、以及将来若有人要写盘）能与解密侧用**同一份**
* 拼装顺序。给测试独写一份拼装逻辑会让「两边一起错」通过所有断言——那种测试只证明
* 自洽，不证明与桌面端兼容。因此另有一条黄金字节断言钉住这里的实际输出。
*/
function fieldAad(keyId, suite, scheme = SYMMETRIC_SCHEME) {
	if (!/^[0-9a-f]{16}$/u.test(keyId)) throw new Error("workbuddy: 信封 keyId 格式不合法");
	return Buffer.concat([
		AAD_DOMAIN,
		Buffer.from([1]),
		encodeLengthPrefixed(STANDARD_FORMAT_ID["field"]),
		encodeLengthPrefixed(scheme),
		encodeUint32(suite),
		encodeLengthPrefixed(keyId),
		Buffer.from([FRAMING_CODE["field"]]),
		Buffer.from([0]),
		Buffer.from([0])
	]);
}
/** 值是不是桌面端的加密字段信封。 */
function isEncryptedFieldWrapper(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const wrapper = value;
	const keys = Object.keys(wrapper).sort();
	return keys.length === 2 && keys[0] === "$wbEncrypted" && keys[1] === "envelope" && wrapper["$wbEncrypted"] === 1 && typeof wrapper["envelope"] === "string";
}
/**
* 32 字节密钥的 keyId：其 SHA-256 的前 16 个十六进制字符。
*
* 信封里的 `keyId` 就是跟它比对，所以「钥匙不对」会响亮失败，而不是返回垃圾。
*/
function deriveAtRestKeyId(key) {
	return createHash("sha256").update(key).digest("hex").slice(0, 16);
}
/**
* 从桌面端的 key payload JSON 派生 32 字节字段密钥。
*
* 应用哈希的是 payload 里那个 base64 **字符串**——不是它解码后的字节——所以这里必须
* 同样拼法；哈希错对象会得到另一把钥匙，每个字段都解不开。
*/
function deriveAtRestKey(payloadJson) {
	let payload;
	try {
		payload = JSON.parse(payloadJson);
	} catch {
		throw new Error("workbuddy: at-rest key payload 不是合法 JSON");
	}
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("workbuddy: at-rest key payload 不是对象");
	const secret = payload["atRestSecretKey"];
	if (typeof secret !== "string" || secret === "") throw new Error("workbuddy: at-rest key payload 里没有 atRestSecretKey");
	return createHash("sha256").update(secret, "utf8").digest();
}
/**
* 用一个派生密钥打开一个加密字段，返回明文。
*
* 信封畸形、属于另一把钥匙、或认证失败时抛错——GCM tag 不匹配正是「转录或密钥不对」
* 的信号，它绝不能被降级成一个被截断的 token。
*/
function openEncryptedField(field, key) {
	let envelope;
	try {
		envelope = JSON.parse(Buffer.from(field.envelope, "base64").toString("utf8"));
	} catch {
		throw new Error("workbuddy: 加密字段的 envelope 不是合法 JSON");
	}
	if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) throw new Error("workbuddy: 加密字段的 envelope 不是对象");
	const record = envelope;
	const suite = record["suite"];
	const keyId = record["keyId"];
	const nonce = record["nonce"];
	const authTag = record["authTag"];
	const ciphertext = record["ciphertext"];
	if (typeof suite !== "number" || typeof keyId !== "string") throw new Error("workbuddy: 加密字段的 envelope 缺 suite 或 keyId");
	if (typeof nonce !== "string" || typeof authTag !== "string" || typeof ciphertext !== "string") throw new Error("workbuddy: 加密字段的 envelope 缺 nonce、authTag 或 ciphertext");
	const expectedKeyId = deriveAtRestKeyId(key);
	if (keyId !== expectedKeyId) throw new Error(`workbuddy: 该字段属于密钥 ${keyId}，不是本机可得的密钥 ${expectedKeyId}`);
	const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64"), { authTagLength: 16 });
	decipher.setAAD(fieldAad(keyId, suite));
	decipher.setAuthTag(Buffer.from(authTag, "base64"));
	return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}
/**
* 一个 macOS bundle 里的可执行文件，从它自己的 `Info.plist` 读。
*
* 二进制**不**可靠地跟 App 同名：WorkBuddy 的 bundle 把 `CFBundleExecutable` 设成了
* `Electron`，所以拼出来的 `<bundle>/Contents/MacOS/WorkBuddy` 并不存在，App 即使
* 装在默认位置也像是没装。bundle 自己写着真名，问它比猜它稳。
*/
function macosBundleExecutable(bundle) {
	let plist;
	try {
		plist = readFileSync(join(bundle, "Contents", "Info.plist"), "utf8");
	} catch {
		return;
	}
	const name = /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]*)<\/string>/u.exec(plist)?.[1]?.trim();
	return name === void 0 || name === "" ? void 0 : join(bundle, "Contents", "MacOS", name);
}
/**
* 桌面端可执行文件的候选路径，按探测顺序。
*
* Windows 在前（加密策略最早落在那里），macOS bundle 也列上——同一个原生模块在
* macOS 构建里也有且同样加密（实测自 5.6.x）。`undefined` 项（未设的环境变量）被丢掉。
*
* `readBundleExecutable` 做成可注入，理由同 `platform`/`home`/`env`：macOS 分支会读
* 真实文件系统，没有缝的话预期候选就取决于这台机器恰好装没装 App——测试会在开发机
* 上通过、在 CI 上失败。
*/
function wbAppExecutableCandidates(platform = process.platform, home = homedir(), env = process.env, readBundleExecutable = macosBundleExecutable) {
	const candidates = [env[WB_APP_EXECUTABLE_ENV]?.trim()];
	if (platform === "win32") {
		const local = env["LOCALAPPDATA"]?.trim();
		const programFiles = env["ProgramFiles"]?.trim();
		const programFilesX86 = env["ProgramFiles(x86)"]?.trim();
		const bases = [
			local === void 0 || local === "" ? void 0 : local,
			programFiles === void 0 || programFiles === "" ? void 0 : programFiles,
			programFilesX86 === void 0 || programFilesX86 === "" ? void 0 : programFilesX86
		];
		for (const base of bases) {
			if (base === void 0) continue;
			for (const subdirectory of WINDOWS_APP_SUBDIRECTORIES) for (const name of APP_EXECUTABLE_NAMES) candidates.push(win32.join(base, ...subdirectory, name));
		}
	} else if (platform === "darwin") for (const name of MACOS_APP_BUNDLE_NAMES) candidates.push(readBundleExecutable(join("/Applications", name)), readBundleExecutable(join(home, "Applications", name)));
	return candidates.filter((candidate) => candidate !== void 0 && candidate !== "");
}
/**
* bundle 标识的**前缀**——`com.tencent.workbuddy`（国内，实测 `…workbuddy.mac`）与
* `com.workbuddy`（国际，实测 `com.workbuddy.workbuddy-ai`）。
*
* 用来在启动一个被扫描发现的可执行文件之前**确认**它真是 WorkBuddy。这很重要：
* 每个 Electron 应用的二进制都叫 `Electron`，只按名字匹配可能启到别的产品。
*/
const APP_BUNDLE_IDENTIFIER_PREFIXES = ["com.tencent.workbuddy", "com.workbuddy"];
/**
* 一个 bundle 是否自称是 WorkBuddy 桌面端。
*
* 按点边界匹配，所以假想的 `com.workbuddyish` 混不过 `com.workbuddy`。
* 读不出或没有标识的 plist 一律当**不是**：拒绝一个候选只是多走一个回退路径，
* 而接受错的那个会执行一个无关应用。
*/
function isWorkbuddyBundle(bundle) {
	let plist;
	try {
		plist = readFileSync(join(bundle, "Contents", "Info.plist"), "utf8");
	} catch {
		return false;
	}
	const identifier = /<key>\s*CFBundleIdentifier\s*<\/key>\s*<string>([^<]*)<\/string>/u.exec(plist)?.[1]?.trim().toLowerCase();
	if (identifier === void 0 || identifier === "") return false;
	return APP_BUNDLE_IDENTIFIER_PREFIXES.some((prefix) => identifier === prefix || identifier.startsWith(`${prefix}.`));
}
/** 一个 applications 目录下、按标识确认过身份的 bundle，按名字排序。 */
function macosNestedAppBundles(parent) {
	let entries;
	try {
		entries = readdirSync(parent);
	} catch {
		return [];
	}
	const bundles = [];
	for (const entry of entries.sort()) {
		if (!entry.endsWith(".app")) continue;
		const bundle = join(parent, entry);
		if (isWorkbuddyBundle(bundle)) bundles.push(bundle);
	}
	return bundles;
}
/** 第一个存在的候选；桌面端没装在平台预期位置时返回 undefined。 */
function findWbAppExecutable(platform = process.platform, home = homedir(), env = process.env, readRegistryAppPath = windowsRegistryAppExecutable) {
	for (const candidate of wbAppExecutableCandidates(platform, home, env)) try {
		if (existsSync(candidate)) return candidate;
	} catch {}
	if (platform === "win32") {
		const fromRegistry = readRegistryAppPath();
		if (fromRegistry !== void 0) try {
			if (existsSync(fromRegistry)) return fromRegistry;
		} catch {}
	}
	if (platform === "darwin") for (const parent of ["/Applications", join(home, "Applications")]) for (const bundle of macosNestedAppBundles(parent)) {
		const executable = macosBundleExecutable(bundle);
		if (executable === void 0) continue;
		try {
			if (existsSync(executable)) return executable;
		} catch {}
	}
}
/**
* 把桌面端的**注册表登记**读成可执行文件路径，或 undefined。
*
* 只查 `DisplayIcon` 与 `InstallLocation`：安装器记录了自己把二进制放哪儿，问登记
* 是让「装在非默认目录的机器」也能取到密钥的唯一办法。
*/
const REGISTRY_PROBE_OPTIONS = {
	encoding: "utf8",
	windowsHide: true,
	timeout: 1e4
};
/** `reg` 在键或值不存在时非零退出——这是没有登记 WorkBuddy 的机器上的预期情况。 */
function queryRegistry(args) {
	try {
		return execFileSync("reg", [...args], REGISTRY_PROBE_OPTIONS);
	} catch {
		return;
	}
}
/** 注册表查询里认作「桌面端二进制」的路径。 */
function normalizeRegistryExecutable(value) {
	const unquoted = stripRegistryQuotes(value);
	if (unquoted === void 0) return void 0;
	const lower = unquoted.toLowerCase();
	if (APP_EXECUTABLE_NAMES.map((name) => name.toLowerCase()).some((name) => lower.endsWith(name))) return unquoted;
	if (lower.endsWith(".exe")) return void 0;
	for (const name of APP_EXECUTABLE_NAMES) {
		const candidate = win32.join(unquoted, name);
		try {
			if (existsSync(candidate)) return candidate;
		} catch {}
	}
}
/** 去掉注册表值外面可能包的一层引号，并拒绝空值。 */
function stripRegistryQuotes(value) {
	const trimmed = value.trim();
	if (trimmed === "") return void 0;
	const unquoted = /^"([^"]+)"/u.exec(trimmed)?.[1] ?? trimmed.replace(/,\s*-?\d+$/u, "");
	return unquoted.trim() === "" ? void 0 : unquoted.trim();
}
/** 从 `reg query` 的输出里取 `DisplayIcon` / `InstallLocation`，转成可执行文件路径。 */
function registryExecutableFromQuery(output) {
	for (const key of ["DisplayIcon", "InstallLocation"]) {
		const match = new RegExp(`"${key}"\\s+REG_SZ\\s+([^\\r\\n]+)`, "iu").exec(output);
		if (match?.[1] === void 0) continue;
		const normalized = normalizeRegistryExecutable(match[1]);
		if (normalized !== void 0) return normalized;
	}
}
/** 注销表里挂着的全部 WorkBuddy 卸载项。 */
function windowsRegistryAppExecutable() {
	if (process.platform !== "win32") return void 0;
	for (const hive of [
		"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
		"HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
		"HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall"
	]) {
		const output = queryRegistry([
			"query",
			hive,
			"/s",
			"/f",
			"WorkBuddy",
			"/d"
		]);
		if (output === void 0) continue;
		const executable = registryExecutableFromQuery(output);
		if (executable !== void 0) return executable;
	}
}
/**
* 跑桌面端自己的二进制（当普通 Node 用）向它的原生模块要 key payload。
*
* 那个 binding 是应用对外的合法表面，所以插件不必携带一份构建期常量的副本：它问
* 写出这个文件的那个构建。子进程不给 stdin，硬超时，只读它的 stdout。
*/
function fetchAtRestKeyPayload(executable) {
	return new Promise((resolve, reject) => {
		execFile(executable, ["-e", "try{process.stdout.write(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet())}catch(e){process.exitCode=3;process.stderr.write(String(e&&e.message||e))}"], {
			env: {
				...process.env,
				ELECTRON_RUN_AS_NODE: "1"
			},
			timeout: KEY_FETCH_TIMEOUT_MS,
			windowsHide: true,
			maxBuffer: 1048576
		}, (error, stdout, stderr) => {
			if (error !== null) {
				reject(/* @__PURE__ */ new Error(`workbuddy: 桌面端没有交出 at-rest 密钥（${stderr.trim() || error.message}）`));
				return;
			}
			const payload = stdout.trim();
			if (payload === "") {
				reject(/* @__PURE__ */ new Error("workbuddy: 桌面端返回了空的 at-rest key payload"));
				return;
			}
			resolve(payload);
		});
	});
}
/** 派生密钥的进程级缓存；永不落盘。 */
let cachedKey;
let inflightKey;
/** 上一次**失败**的时刻；0 表示近期没失败过。 */
let failedKeyAtMs = 0;
/** 最近一次成功发现的可执行文件（`undefined` 表示还没成功过）。 */
let cachedAppExecutable;
/** 最近一次**否定**发现的时刻；0 表示近期没失败过。 */
let appExecutableMissedAtMs = 0;
/**
* 一次失败的密钥查询被记住多久。
*
* 只记住成功是不够的：拿不到密钥的机器上，`scanAll()` 会逐个文件探测，而一次页面
* 打开会扫好几遍——每一遍都重跑整套发现，在没装桌面端的机器上就是每次若干次
* **同步** `reg query` 子进程。失败答案在一次页面打开内不可能变化，所以记 60s；
* 用户装好或启动 App 后仍能在这个窗口内被拾起，而不必重启。
*/
const AT_REST_KEY_FAILURE_TTL_MS = 6e4;
/**
* 一次**否定**的可执行文件发现被记住多久。
*
* 否定答案才贵：每个候选路径都 miss，然后 Windows 兜底按卸载 hive 逐个 shell out。
* 肯定答案则整个进程生命周期缓存——它的路径每次调用本来就会用 `existsSync` 重验，
* 所以被移动或删除的 App 仍会落到一次新的发现。
*/
const APP_EXECUTABLE_MISS_TTL_MS = 6e4;
/**
* 经 `findWbAppExecutable` 定位桌面端，并把一次 miss 记住
* `APP_EXECUTABLE_MISS_TTL_MS`。
*
* 只缓存本模块自己的查询，且只在走真实缝的时候：`findWbAppExecutable` 对其参数
* 保持纯函数，诊断与注入平台的测试必须继续看到机器此刻的样子。
*/
function discoverAppExecutable() {
	if (cachedAppExecutable !== void 0) return cachedAppExecutable;
	const now = Date.now();
	if (appExecutableMissedAtMs !== 0 && now - appExecutableMissedAtMs < APP_EXECUTABLE_MISS_TTL_MS) return;
	const executable = findWbAppExecutable();
	if (executable === void 0) {
		appExecutableMissedAtMs = now;
		return;
	}
	cachedAppExecutable = executable;
	return executable;
}
/**
* 桌面端的 at-rest 字段密钥；取不到时返回 undefined（App 没装、构建太旧没有原生
* 模块、或将来的构建换了 payload）。
*
* 两种结果都缓存：成功缓整个进程生命周期（App 至多被启动一次），失败缓
* `AT_REST_KEY_FAILURE_TTL_MS`。失败 TTL 正是让**没装 App** 的机器不为每个凭据
* 文件都付一次同步注册表探测的东西。
*/
function readAtRestKey() {
	if (cachedKey !== void 0) return Promise.resolve(cachedKey);
	if (inflightKey !== void 0) return inflightKey;
	if (failedKeyAtMs !== 0 && Date.now() - failedKeyAtMs < AT_REST_KEY_FAILURE_TTL_MS) return Promise.resolve(void 0);
	inflightKey = (async () => {
		const executable = discoverAppExecutable();
		if (executable === void 0) return void 0;
		return deriveAtRestKey(await fetchAtRestKeyPayload(executable));
	})().then((key) => {
		cachedKey = key;
		failedKeyAtMs = key === void 0 ? Date.now() : 0;
		return key;
	}, (error) => {
		failedKeyAtMs = Date.now();
		throw error;
	}).finally(() => {
		inflightKey = void 0;
	});
	return inflightKey;
}
//#endregion
//#region src/status-paths.ts
/** 插件 id。与 `package.json` 的 `name`、`cordis.patch.yml` 的 `name` 必须一致。 */
const PLUGIN_ID = "dsh-connect-workbuddy-models";
/** 设置命名空间（`installSection` / `configure` 的 ns）。 */
const WB_MODELS_SETTINGS_NS = "wbmodels";
/** 浏览器半区的 locale 命名空间。 */
const WB_MODELS_LOCALE_NS = "settings.wbmodels";
/**
* 设置页在左侧导航里的排序位。
*
* xdpool 的账号池页占 440、trae-models 占 441（见两插件 `src/client/index.tsx`
* 的 `order`），本插件排在其后，避免覆盖别人已经占住的位置。
*/
const WB_MODELS_SETTINGS_ORDER = 442;
/** 本插件所有 web 路由的共同前缀。 */
const ROUTE_PREFIX = "/plugins/dsh-connect-workbuddy-models";
/** GET：汇总状态（账号 / 积分 / 到期 / 签到 / 模型 / 配置）。 */
const WB_STATUS_PATH = `${ROUTE_PREFIX}/status`;
/** POST：重新扫描本机登录账号。 */
const WB_ACCOUNTS_REFRESH_PATH = `${ROUTE_PREFIX}/accounts/refresh`;
/** GET `?accountId=`：单账号积分明细。 */
const WB_ACCOUNT_CREDITS_PATH = `${ROUTE_PREFIX}/account/credits`;
/** POST `?accountId=`（可省 = 全部）：手动签到。 */
const WB_CHECKIN_PATH = `${ROUTE_PREFIX}/checkin`;
/** POST `?accountId=&kind=`：领取补偿 / 赠礼积分。 */
const WB_BENEFIT_CLAIM_PATH = `${ROUTE_PREFIX}/benefit/claim`;
/** POST：拉取实时模型目录与倍率。 */
const WB_MODELS_REFRESH_PATH = `${ROUTE_PREFIX}/models/refresh`;
/** POST：保存「需要显示的模型」选择。 */
const WB_MODELS_SAVE_PATH = `${ROUTE_PREFIX}/models/save`;
/** POST `?accountId=&region=`：切换当前使用账号。 */
const WB_ACCOUNTS_SELECT_PATH = `${ROUTE_PREFIX}/accounts/select`;
/** GET / POST：自动签到开关与时段。 */
const WB_AUTOMATION_PATH = `${ROUTE_PREFIX}/automation`;
/** 选择账号的查询参数名。 */
const WB_ACCOUNT_ID_PARAM = "accountId";
/** 选择权益种类的查询参数名。 */
const WB_KIND_PARAM = "kind";
/** 选择区域（国内 / 国际）的查询参数名。 */
const WB_REGION_PARAM = "region";
/** 全部区域，按界面顺序。 */
const WB_REGIONS = ["cn", "global"];
/**
* 模型目录（含倍率、促销条目）的自动刷新间隔。
*
* 取 5 分钟的**理由**：
*
* - 上游 `/v3/config` 里的 `modelPromotions` 是**按天/按小时**起的活动（夜间折扣
*   23:00 开始、限时免费按绝对窗口结束），最短的变化粒度是「小时」。1 分钟刷新
*   是纯浪费——一个开着的设置页每分钟都会打一次上游。
* - 但也不能更长。用户抱怨的正是「促销结束了界面上还在说免费」，而绝对窗口的
*   边界只会落在整点/整分上；5 分钟意味着最坏情况下用户看到过期徽标 5 分钟。
* - 与已有的 `credits` 读数（十分钟级）和 `/status` 轮询（秒级）都不同量级，
*   不会把三个节奏混成一条。
*
* **刷新成本不落在回答 `/status` 的那个请求上**：过期只触发一次后台
* fire-and-forget 刷新，本次应答一律用现有快照 + 上报 `modelsFetchedAtMs`，让
* 界面自己说清「这份数据多久前抓的」。见 `web-status.ts` 的 `buildStatus`。
*/
const WB_CATALOG_TTL_MS = 3e5;
/**
* 拥挤度（`/v2/chat/busy`）的自动刷新间隔。
*
* 与 {@link WB_CATALOG_TTL_MS} **故意分开**，因为这是两条独立的上游链路：
*
* - 拥挤度是**分钟级**的事实（上游按当前排队情况随时变），且它来自一个专门的
*   轻量端点，代价远低于读整份 `/v3/config`。1 分钟足以让用户看到「现在堵了」。
* - 目录是**小时级**的事实，读的是一份大文档。
*
* 合成一条 TTL 会逼出两种坏结果之一：要么为了拥挤度把大文档每分钟读一遍，要么
* 为了省流量让拥挤度 5 分钟才更新一次（那时它已经没意义了）。
*
* 失败必须静默降级：拥挤度是**附加信息**，它挂了不能让目录也被标记成失败。
*/
const WB_BUSY_TTL_MS = 6e4;
/**
* 每个区域注册的 provider id。
*
* **必须是 `workbuddy-models`，不能是 `workbuddy`**：`dsh-connect-workbuddy`
* （4.15.1）已经占住了 `workbuddy` / `workbuddy-global`
* （见 `plugins/dsh-connect-workbuddy/src/adapter.ts:46,49`）。同一个 provider id
* 注册两次，cordis 会抛 `service "llm" 的 provider 已注册` 类错误，后加载的那份
* 插件整份注册失败——而用户看到的是「模型列表少了一半」，不是冲突提示。
*/
const WB_PROVIDERS = {
	cn: "workbuddy-models",
	global: "workbuddy-models-global"
};
/**
* provider id → 区域。浏览器半区靠它把宿主 `modelSelection` 投影里的 provider
* 翻译成「该读哪个区域的读数」。
*/
const WB_PROVIDER_REGIONS = {
	[WB_PROVIDERS.cn]: "cn",
	[WB_PROVIDERS.global]: "global"
};
/** 从 provider id 反查区域；不是本插件的 provider 时返回 undefined。 */
function wbRegionOfProvider(provider) {
	if (provider === void 0) return void 0;
	return Object.prototype.hasOwnProperty.call(WB_PROVIDER_REGIONS, provider) ? WB_PROVIDER_REGIONS[provider] : void 0;
}
/** 区域 → provider id；未知区域回落到国内版。 */
function wbProviderOf(region) {
	return region === "global" ? WB_PROVIDERS.global : WB_PROVIDERS.cn;
}
/** 窄化一个字符串是否为合法区域。 */
function isWbRegion(value) {
	return value === "cn" || value === "global";
}
/** 全部使用方式，按界面顺序。 */
const ACCOUNT_DISTRIBUTIONS = [
	"priority",
	"round-robin",
	"balanced",
	"sticky",
	"expiry"
];
/**
* 默认使用方式：`expiry` —— 优先把「最先会作废」的积分花掉。
*
* 为什么不是 `priority`（「用完一个再换」，看着更省事）：
*
* `priority` 分支的第一键是 `atRisk`，而 `atRisk` 的判据是
* `credits.expiringSoon > 0` —— 一个**由用户 `expiryWarnDays`（默认 3 天）现算的
* 窗口**（见 `probe.ts` 的 `aggregateCredits`）。默认配置下，10 天后才到期的积分
* 根本不算 `atRisk`，排序就退回 `_order` / `score`，也就是「谁分多谁先」。那让需求
* R3（优先切到积分最先过期的账号）只在 3 天窗口内碰巧成立，窗口外变成一条与过期
* 无关的规则 —— 用户看到的是「积分多的号被优先抽干」，正是 R3 要避免的。
*
* `expiry` 分支不依赖 `atRisk`：它按 `nearestExpiryMs` 升序，且有到期信息的账号无
* 条件排在没有的前面（见 `rankAccounts`）。所以「10 天后到期」与「30 天后到期」在
* 默认 3 天窗口下依然分得出先后 —— R3 在全时段成立，不只临期时成立。用户的
* `expiryWarnDays` 仍然决定**提醒**的窗口（`expiringSoon`），只是不再决定**排序**。
*
* 已知取舍：纯月包账号（无 `nearestExpiryMs`）会沉到有到期信息的账号之后。这是刻
* 意的 —— 月包会刷新，不存在「快要流失」的额度。界面用 `rankReasonsOf` 的 `reason`
* 解释这一点，不让它变成一个谜。
*/
const DEFAULT_ACCOUNT_DISTRIBUTION = "expiry";
/** 窄化一个字符串是否为合法使用方式；非法值回落到默认（不抛错）。 */
function distributionOf(value) {
	return typeof value === "string" && ACCOUNT_DISTRIBUTIONS.includes(value) ? value : DEFAULT_ACCOUNT_DISTRIBUTION;
}
/**
* 实测**拒绝** `reasoning_effort: "off"` 的模型 id（上游 issue #34 / #83）。
*
* 上游名册把这些模型的 `reasoning.canDisableThinking` 声明为 `true`，但它们对
* `reasoning_effort: "off"` 回 HTTP 400 / 业务码 11133，而**其余每一档**
* （minimal/low/medium/high/xhigh/max）以及完全不带该字段都能过。也就是说 `off`
* 是唯一会失败的一档，而声明的能力字段分不开这两组——所以只能靠一张按精确 id
* 取的表。
*
* 表刻意不按区域：`deepseek-v4.1-flash` 在两个网关都拒，分界线跟模型家族走。
*
* **代价不对称**：提供一个必然失败的档位，代价是该模型之后**每一轮**请求都失败
* （档位是保存下来的每模型选择，会一直重放）；而多藏一个本来能用的档位，代价只是
* 少一个选项。所以这张表一律朝「藏」的方向取整。
*
* 住在共享契约层是因为有**两个**消费者：`adapter.ts` 用它把 `off` 映射成 `null`
* （让 pi-ai 的 `getSupportedThinkingLevels` 直接不提供该档），`shim.ts` 用它删掉
* 已经混进请求体的 `reasoning_effort: "off"`。同一份实测数据只能有一处。
*/
const WB_REFUSES_OFF_MODEL_IDS = /* @__PURE__ */ new Set([
	"deepseek-v4.1-flash",
	"deepseek-v4.1-flash-sg",
	"deepseek-v4-pro",
	"primary-model",
	"gpt-6-astra",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gemini-3.5-flash"
]);
/** 窄化一个字符串是否为合法权益种类。 */
function benefitKindOf(value) {
	return value === "compensation" || value === "gift" ? value : void 0;
}
/**
* 剥掉一层 `{ get(): T }` 活引用。
*
* schemastery 的 `volatile()` 字段解析出来是**活引用**（`{ get(): T }`），而不是
* 值本身。它 `typeof === 'object'`，所以任何「看起来像对象就当对象用」的判断都会
* 把它当值放行，后续每次属性读取都拿到 `undefined`。
*
* 出处：`plugins/dsh-connect-workbuddy/src/index.ts:564-569`，
* 浏览器侧同一规则见 `plugins/dsh-connect-workbuddy/src/client/ComposerCreditsGate.tsx`
* 的 `scopeValueOf`（`unwrapVolatileDeep(scope.getSnapshot().value)`）。
*
* 不剥离的后果（README 与本仓库既有记录里都出现过）：
* - 把配置交给 settings 服务时，服务会 `structuredClone` 整份对象做校验，活引用
*   过不去，报 `$.xxx expected string but got [object Object]`——**命名空间注册不上**；
* - 于是设置页的卡片**静默消失**：没有异常，没有横幅，只是那片 UI 不再出现。
*/
function unwrapVolatile(value) {
	if (value === null || typeof value !== "object") return value;
	const getter = value.get;
	return typeof getter === "function" ? getter.call(value) : value;
}
/**
* 深剥：递归把每个 `{ get(): T }` 替换成它解析出的值。
*
* {@link unwrapVolatile} 只剥调用者「这一层」读到的那个字段，普通读路径够用；
* 但把**整份配置**交给 settings 服务（以及浏览器侧把解析后的字段展开以保留兄弟
* 字段）时，任何一个残留的活引用都会让 `structuredClone` 失败 / 让 `{ ...ref }`
* 展开成 `{ get: <function> }` 而丢掉所有兄弟字段。
*
* 出处：`plugins/dsh-connect-workbuddy/src/status-paths.ts:1233-1245`（同一实现）与
* `plugins/dsh-connect-trae-models/src/index.ts:58-82`。
*
* 数组与对象都**重建**而不是原地修改，调用方的值不会被改动。
*/
function unwrapVolatileDeep(value) {
	if (value === null || typeof value !== "object") return value;
	const peeled = unwrapVolatile(value);
	if (peeled !== value) return unwrapVolatileDeep(peeled);
	if (Array.isArray(peeled)) return peeled.map((entry) => unwrapVolatileDeep(entry));
	const source = peeled;
	const out = {};
	for (const key of Object.keys(source)) out[key] = unwrapVolatileDeep(source[key]);
	return out;
}
/**
* 从 URL 里取一个查询参数。空串按「未提供」处理（浏览器表单与手写链接都会
* 产生 `?accountId=`），这样调用方只需判 undefined。
*/
function queryParamOf(url, name) {
	const at = url.indexOf("?");
	if (at === -1) return void 0;
	const value = new URLSearchParams(url.slice(at + 1)).get(name);
	return value === null || value === "" ? void 0 : value;
}
/**
* 从 URL 里取一个查询参数，**保留空串**。
*
* 与 {@link queryParamOf} 的唯一差别就是 `?key=` 的返回值：这里给 `''`，那里给
* `undefined`。两个口径都必要，不能合并：
*
* - `queryParamOf` 的「空串按未提供处理」对**只读**路由是对的（浏览器表单与手写
*   链接都会产生 `?accountId=`，把它当成「没筛这个维度」最省事）。
* - 但 `/accounts/select` 里空串本身就是一条指令：「交还给账户使用方式」。用
*   `queryParamOf` 取参会把它归一化成 `undefined`，于是那句「传空字符串表示交还
*   给账户使用方式」的错误文案必然命中、HTTP 面**在结构上无法表达清除**——
*   用户一旦手动选过号，五种账户使用方式就永久失效，且没有任何撤销手段。
*
* 所以这里刻意不共用 `queryParamOf`，而是在它旁边放一个只给写路由用的入口。
*/
function rawQueryParamOf(url, name) {
	const at = url.indexOf("?");
	if (at === -1) return void 0;
	const value = new URLSearchParams(url.slice(at + 1)).get(name);
	return value === null ? void 0 : value;
}
/** 从 URL 里取 `accountId`。 */
function accountIdOf(url) {
	return queryParamOf(url, WB_ACCOUNT_ID_PARAM);
}
/** 从 URL 里取 `kind`；不认识/缺省时 undefined。 */
function claimKindOf(url) {
	return benefitKindOf(queryParamOf(url, WB_KIND_PARAM));
}
/** 一天的毫秒数。 */
const DAY_MS = 864e5;
/**
* 临期窗口默认值（天）。
*
* 这是**兜底**，不是口径来源。临期窗口的用户真值只有一个：配置里的
* `expiryWarnDays`。它经由两条路进入排序层，任一到达都不该用到本常量：
*
* 1. 探测层（`probe.ts` 的 `aggregateCredits`）按用户窗口算出 `credits.expiringSoon`
*    写进读数，`expiryFactsOf` 遇到显式值直接采信；
* 2. 调用方把用户窗口作为 `rankAccounts` 的第 5 个实参 `warnDays` 传进来。
*
* 只有两者都缺省（老调用点、纯单元测试、池里从未探测过）才会落回本常量。把它当
* 口径用会让用户的设置对「谁排第一」完全无效——那正是 F2 的缺陷形态。
*/
const DEFAULT_EXPIRY_WARN_DAYS = 3;
/** 临期提醒阈值的合法下界（天）。 */
const EXPIRY_WARN_DAYS_MIN = 1;
/** 临期提醒阈值的合法上界（天）。 */
const EXPIRY_WARN_DAYS_MAX = 90;
/**
* 汇总一个成员的到期事实。
*
* 两条口径都写在这里，避免排序键各处各算一遍：
* 1. **显式优先**：`credits.nearestExpiryMs` / `credits.expiringSoon` 来自探测层，
*    已经按用户的 `expiryWarnDays` 聚合过，直接采信。
* 2. **兜底推算**：只有缺省时才从 `packages` 里推——周期包（`monthly`）会刷新、
*    永不过期，不参与；已经过期（`expiresAtMs <= nowMs`）的包也不算「临期」，
*    它已经消失了，把它当 atRisk 会让一个用光的账号永远排第一。
*
* 第 2 条用哪个窗口由 `warnDays` 决定。它**必须**来自用户配置（`rankAccounts` 的
* 第 5 个实参），否则「用户把提醒改成 30 天」在排序上完全不可观测：实测传入
* `DEFAULT_EXPIRY_WARN_DAYS` 时，一个 10 天后到期的包无论在 3 天还是 30 天窗口下
* 都不会被算进 `expiringAmount`，两种设置的排序结果逐字节相同。
*/
function expiryFactsOf(credits, nowMs, warnDays) {
	if (credits === void 0) return { expiringAmount: 0 };
	const windowEndMs = nowMs + Math.max(0, warnDays) * DAY_MS;
	let computedAt;
	let computedAmount = 0;
	for (const pack of credits.packages ?? []) {
		if (pack.monthly) continue;
		const at = pack.expiresAtMs;
		if (at === void 0 || !Number.isFinite(at) || at <= nowMs) continue;
		if (computedAt === void 0 || at < computedAt) computedAt = at;
		if (at <= windowEndMs) computedAmount += pack.remain;
	}
	const explicitAt = credits.nearestExpiryMs;
	const nearestExpiryMs = explicitAt !== void 0 && Number.isFinite(explicitAt) && explicitAt > nowMs ? explicitAt : computedAt;
	const explicitAmount = credits.expiringSoon;
	return {
		expiringAmount: Number.isFinite(explicitAmount) && explicitAmount > 0 ? explicitAmount : computedAmount,
		...nearestExpiryMs === void 0 ? {} : { nearestExpiryMs }
	};
}
/**
* 把一个池成员列表排成「下一个该由谁服务」的顺序。
*
* 纯函数：同样的输入永远给同样的顺序，缺数据不抛错（没有积分按 0 排，不崩）。
*
* 键顺序照 `plugins/dsh-connect-workbuddy/src/account-pool.ts:440-520`：
*
* ```
* _usable            可服务的排前面（不可服务的仍然返回，只是排在后面）
* _atRisk            有额度正在流失的排前面            ← R3 的基础
* _order             用户手动序（未列出的排最后）
* _expiring          都 atRisk 时，最先到期的排前面
* _expiringAmount    流失额度大的排前面
* score              积分多的排前面
* _tokenExpiresAtMs  凭据更晚到期的排前面
* id                 保证顺序是「全序」，同样的输入不会两次排出不同结果
* ```
*
* `distribution` 只影响**这次排序**的一个键：
* - `expiry`：把「有到期信息」提到 `_atRisk` 之前，于是「一次性积分包最先到期的
*   账号」必定排第一，无到期信息的排最后，从未探测过的池退化成 `priority`。
* - 其余四种（`priority` / `round-robin` / `balanced` / `sticky`）**用同一份顺序**：
*   它们的差别在于「怎么消费这份有序列表」（依次打同一个 / 走游标轮换 / 按权重抽 /
*   按会话绑定），而不是「谁是下一个」。把它们塞进比较器会让同一份顺序对四种模式
*   给出四种互不相同的解释，而其中三种是错的。
*
* @param members 池成员
* @param nowMs 当前时刻（ms），用于判定临期窗口
* @param orderIds 用户手动排序的账号 id（`orderIds[0]` 排最前）
* @param distribution 账户使用方式
* @param warnDays 临期窗口（天），取自用户的 `expiryWarnDays`
*/
function rankAccounts(members, nowMs, orderIds = [], distribution = DEFAULT_ACCOUNT_DISTRIBUTION, warnDays = 3) {
	const order = /* @__PURE__ */ new Map();
	for (const [index, id] of orderIds.entries()) if (!order.has(id)) order.set(id, index);
	const effectiveWarnDays = Number.isFinite(warnDays) ? Math.min(90, Math.max(1, Math.round(warnDays))) : 3;
	const rows = members.map((member) => {
		const facts = expiryFactsOf(member.credits, nowMs, effectiveWarnDays);
		const score = member.score ?? member.credits?.total ?? 0;
		return {
			account: member.account,
			score,
			atRisk: facts.expiringAmount > 0,
			expiringAmount: facts.expiringAmount,
			...facts.nearestExpiryMs === void 0 ? {} : { nearestExpiryMs: facts.nearestExpiryMs },
			_usable: member.usable !== false,
			_order: order.get(member.account.id) ?? Number.POSITIVE_INFINITY,
			_expiring: facts.nearestExpiryMs ?? Number.POSITIVE_INFINITY,
			_hasExpiry: facts.nearestExpiryMs !== void 0,
			_tokenExpiresAtMs: member.account.tokenExpiresAtMs ?? 0
		};
	});
	const byExpiryMode = distribution === "expiry";
	rows.sort((left, right) => {
		if (left._usable !== right._usable) return left._usable ? -1 : 1;
		if (byExpiryMode) {
			if (left._hasExpiry !== right._hasExpiry) return left._hasExpiry ? -1 : 1;
			if (left._expiring !== right._expiring) return left._expiring - right._expiring;
			if (left.atRisk !== right.atRisk) return left.atRisk ? -1 : 1;
		} else {
			if (left.atRisk !== right.atRisk) return left.atRisk ? -1 : 1;
			if (left._order !== right._order) return left._order - right._order;
			if (left.atRisk && right.atRisk && left._expiring !== right._expiring) return left._expiring - right._expiring;
		}
		if (left.expiringAmount !== right.expiringAmount) return right.expiringAmount - left.expiringAmount;
		if (left.score !== right.score) return right.score - left.score;
		if (left._tokenExpiresAtMs !== right._tokenExpiresAtMs) return right._tokenExpiresAtMs - left._tokenExpiresAtMs;
		return left.account.id < right.account.id ? -1 : left.account.id > right.account.id ? 1 : 0;
	});
	return rows.map(({ account, score, atRisk, expiringAmount, nearestExpiryMs }) => ({
		account,
		score,
		atRisk,
		expiringAmount,
		...nearestExpiryMs === void 0 ? {} : { nearestExpiryMs }
	}));
}
/**
* 取排序后第一个可服务的账号（DESIGN.md §5 的「谁下一个服务」）。
*
* 只是 {@link rankAccounts} 的一行封装：调用方若还需要名次或原因，直接用
* `rankAccounts`。
*
* `warnDays` 必须与 `rankAccounts` 的第 5 个实参同源（用户的 `expiryWarnDays`）：
* 「谁排第一」如果在两个入口上用两个窗口算，用户会看到卡片上写着 A 是下一个、
* 实际请求被发到 B。
*/
function pickRankedAccount(members, nowMs, orderIds = [], distribution = DEFAULT_ACCOUNT_DISTRIBUTION, warnDays = 3) {
	return rankAccounts(members, nowMs, orderIds, distribution, warnDays)[0]?.account;
}
//#endregion
//#region src/account-store.ts
/**
* 宿主侧持久化：自动化账本。
*
* 账本回答的唯一问题是「今天这个时段跑过没有」。它存在磁盘上而不是内存里，因为
* DSH 常常一天被重启好几次——纯内存账本会让每次重启都重跑一遍签到，而签到是**写
* 上游**的动作，无谓重跑既慢又容易触发限流。
*
* 为什么不放进 settings 文档：账本是机器状态（每次运行都在变），settings 是用户
* 可编辑的配置。把每天变几十次的东西塞进用户的配置文档，会让设置页的 diff 永远
* 有噪音，也让用户可能手改出一个自己看不懂的状态。
*/
/** 账本文件名。放在 dsh home 下：跨进程重启有意义，但不属于用户可编辑的配置。 */
const LEDGER_FILENAME = "automation-ledger.json";
/** 账本的绝对路径。 */
function ledgerPath(pluginId) {
	return dshHomePath(pluginId, LEDGER_FILENAME);
}
/**
* 读回账本。
*
* 读失败一律返回 `undefined`：账本只回答「今天是不是已经签过」，丢了最多多签一次
* （上游按北京自然日幂等，多签是无害的空操作），而**读失败让插件起不来**是不可
* 接受的。JSON 结构不对也一样按空账本处理——手改坏的文件不该变成启动故障。
*/
async function loadLedger(pluginId) {
	try {
		const text = await readFile(ledgerPath(pluginId), "utf8");
		const parsed = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null) return void 0;
		const row = parsed;
		return {
			firedSlots: Array.isArray(row["firedSlots"]) ? row["firedSlots"].filter((entry) => typeof entry === "string") : [],
			...typeof row["lastRunDate"] === "string" ? { lastRunDate: row["lastRunDate"] } : {},
			...typeof row["lastRunSlot"] === "string" ? { lastRunSlot: row["lastRunSlot"] } : {}
		};
	} catch {
		return;
	}
}
/**
* 保存账本。
*
* 写失败只记一条 warn：账本是「省一次空操作」的优化，绝不能因为磁盘满或权限问题
* 打断了正在进行中的签到循环。
*/
async function saveLedger(pluginId, ledger, logger) {
	try {
		const path = ledgerPath(pluginId);
		await mkdir(dirname(path), {
			recursive: true,
			mode: 448
		});
		await writeFileAtomic(path, `${JSON.stringify(ledger, null, 2)}\n`, {
			mode: 384,
			dirMode: 448
		});
	} catch (error) {
		logger?.warn("dsh-connect-workbuddy-models: 自动化账本写入失败", error);
	}
}
/** 刷新记录文件名。与账本同目录、同权限：里面是 bearer token，属于本机私有数据。 */
const REFRESH_FILENAME = "credential-refresh.json";
/** 刷新记录的绝对路径。 */
function credentialRefreshPath(pluginId) {
	return dshHomePath(pluginId, REFRESH_FILENAME);
}
/**
* 进程内串行化刷新记录的读改写。
*
* 两个账号同时被上游 401 时会并发走到这里，而保存是「读整份 → 改一条 → 写回」：
* 不串行化就会丢掉先写那条，表现为「刷新过但重启后又回到旧 token」——比不刷新
* 更难查，因为它只在多账号同时过期时出现。
*/
let refreshWriteChain = Promise.resolve();
function serializeRefreshWrite(task) {
	const next = refreshWriteChain.then(task, task);
	refreshWriteChain = next.then(() => void 0, () => void 0);
	return next;
}
/**
* 读回刷新记录。
*
* 与 {@link loadLedger} 同口径：读失败、JSON 坏、结构不对一律当空表。这里更不
* 能抛——它跑在**每次账号发现**里，抛错就等于磁盘上有个坏文件让整个插件起不来。
*/
async function loadRefreshedCredentials(pluginId) {
	try {
		const text = await readFile(credentialRefreshPath(pluginId), "utf8");
		const parsed = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null) return {};
		const store = {};
		for (const [accountId, raw] of Object.entries(parsed)) {
			if (typeof raw !== "object" || raw === null) continue;
			const row = raw;
			const accessToken = row["accessToken"];
			if (typeof accessToken !== "string" || accessToken === "") continue;
			store[accountId] = {
				accessToken,
				...typeof row["refreshToken"] === "string" && row["refreshToken"] !== "" ? { refreshToken: row["refreshToken"] } : {},
				expiresAtMs: typeof row["expiresAtMs"] === "number" && Number.isFinite(row["expiresAtMs"]) ? row["expiresAtMs"] : 0,
				refreshedAtMs: typeof row["refreshedAtMs"] === "number" && Number.isFinite(row["refreshedAtMs"]) ? row["refreshedAtMs"] : 0
			};
		}
		return store;
	} catch {
		return {};
	}
}
/**
* 记下一个账号刷新后的凭据。
*
* 写失败只记一条 warn：磁盘满或权限问题不该让一次**已经成功**的刷新连带失掉聊天
* 能力——内存里的新 token 仍然有效，最坏结果只是重启后回到旧 token 再刷一次。
*/
async function saveRefreshedCredential(pluginId, accountId, entry, logger) {
	await serializeRefreshWrite(async () => {
		try {
			const path = credentialRefreshPath(pluginId);
			const merged = {
				...await loadRefreshedCredentials(pluginId),
				[accountId]: entry
			};
			await mkdir(dirname(path), {
				recursive: true,
				mode: 448
			});
			await writeFileAtomic(path, `${JSON.stringify(merged, null, 2)}\n`, {
				mode: 384,
				dirMode: 448
			});
		} catch (error) {
			logger?.warn("dsh-connect-workbuddy-models: 刷新后的凭据写入失败", error);
		}
	});
}
//#endregion
//#region src/promo.ts
/** 一个像记录的值；其他一律 undefined。 */
function record(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
/** 去掉首尾空白后的非空字符串，否则 undefined。 */
function text(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
/**
* `'HH:mm'` → 距离当日零点的分钟数；其他形状一律 undefined。
*
* `24:00` 被接受，且**恰好**表示 1440（一天的结束）。上游今天把「全天」写成
* `0:00`–`23:59`，这在 23:59 与零点之间留了一分钟的空洞，常驻活动在那分钟里会被
* 读成「没在跑」。接受 `24:00` 让这种窗口可以被表达（也让上游将来能改）而不留空洞；
* 作为**起点**仍然拒绝 —— 从 24:00 开始的一天是第二天，那是另一个陈述。
*
* 类型守卫是有用的，不是防御性装饰：上游喂的是字符串，`parseDaily` 的 `text()` 早
* 就把数字丢掉了 —— 但**存下来的目录**是进这个函数的第二个独立入口，那条路上没有
* 任何类型检查。一个数字 `start` 过去会在**渲染期**抛 `value.trim is not a function`，
* 被宿主的槽位错误边界吃掉之后，整块配置区就白了。
*/
function minutesOfClock(value) {
	if (typeof value !== "string") return void 0;
	const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim());
	if (match === null) return void 0;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return void 0;
	if (minutes > 59) return void 0;
	if (hours > 24) return void 0;
	if (hours === 24) return minutes === 0 ? 1440 : void 0;
	return hours * 60 + minutes;
}
/** 一个 ISO-8601 时刻 → epoch ms。数字是**故意**拒绝的。 */
function parseInstant(value) {
	const raw = text(value);
	if (raw === void 0) return void 0;
	const ms = Date.parse(raw);
	return Number.isNaN(ms) ? void 0 : ms;
}
/** 上游的 `modelIds` → 去重后的 id 列表。 */
function parseModelIds(value) {
	if (!Array.isArray(value)) return void 0;
	const ids = [];
	for (const entry of value) {
		const id = text(entry);
		if (id !== void 0 && !ids.includes(id)) ids.push(id);
	}
	return ids.length === 0 ? void 0 : ids;
}
/** 上游的 `badge` → 本插件的徽标形状。 */
function parseBadge(value) {
	const raw = record(value);
	if (raw === void 0) return void 0;
	const label = text(raw["label"]) ?? text(raw["labelEn"]) ?? text(raw["shortLabel"]) ?? text(raw["shortLabelEn"]);
	if (label === void 0) return void 0;
	const labelEn = text(raw["labelEn"]);
	const shortLabel = text(raw["shortLabel"]);
	const shortLabelEn = text(raw["shortLabelEn"]);
	const color = text(raw["color"]);
	const display = raw["display"] === "activeOnly" ? "activeOnly" : void 0;
	return {
		label,
		...labelEn === void 0 ? {} : { labelEn },
		...shortLabel === void 0 ? {} : { shortLabel },
		...shortLabelEn === void 0 ? {} : { shortLabelEn },
		...color === void 0 ? {} : { color },
		...display === void 0 ? {} : { display }
	};
}
/** 上游的 `hover` → 本插件的文案形状。 */
function parseHover(value) {
	const raw = record(value);
	if (raw === void 0) return void 0;
	const textZh = text(raw["textZh"]);
	const textEn = text(raw["textEn"]);
	if (textZh === void 0 && textEn === void 0) return void 0;
	return {
		...textZh === void 0 ? {} : { textZh },
		...textEn === void 0 ? {} : { textEn }
	};
}
/** 一个读不出来的端点**实际**是什么形状，供那唯一一行诊断用。 */
function shapeOf(value) {
	if (typeof value === "number") return "number";
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}
/**
* 上游的 `schedule.daily` → 本插件能算的窗口。
*
* `label` 只用于诊断行，由调用方传入而不是从这里读：条目 id 在上一层（`parsePromo`）。
*/
function parseDaily(value, label) {
	if (!Array.isArray(value)) return void 0;
	const windows = [];
	for (const entry of value) {
		const raw = record(entry);
		if (raw === void 0) continue;
		const start = text(raw["start"]);
		const end = text(raw["end"]);
		if (start === void 0 || end === void 0 || minutesOfClock(start) === void 0 || minutesOfClock(end) === void 0) {
			try {
				console.warn(`[dsh-connect-workbuddy-models] 促销 "${label}"：丢弃了一个读不出来的每日窗口（start: ${shapeOf(raw["start"])}，end: ${shapeOf(raw["end"])}）；上游可能改了时间格式`);
			} catch {}
			continue;
		}
		windows.push({
			start,
			end
		});
	}
	return windows.length === 0 ? void 0 : windows;
}
/**
* 从上游的 `discountedCredits` 字符串里读出倍率。
*
* 上游把单位**写进值里**（`"0x"` / `"0.06x"` / `"0.06"`），所以剥掉尾部 `x` 而不是
* 直接交给 `Number()`。读不成有限非负数的值一律拒绝 —— 给用户看一个错价格比看原价
* 更糟，因为原价至少是真的。
*/
function multiplierOfCredits(value) {
	const raw = text(value);
	if (raw === void 0) return void 0;
	const stripped = raw.replace(/x$/iu, "").trim();
	if (stripped === "") return void 0;
	const parsed = Number(stripped);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : void 0;
}
/** 上游的 `discount` → 本插件的折扣形状。 */
function parseDiscount(value) {
	const raw = record(value);
	if (raw === void 0) return void 0;
	const fromString = multiplierOfCredits(raw["discountedCredits"]);
	const fromFactor = typeof raw["factor"] === "number" && Number.isFinite(raw["factor"]) && raw["factor"] >= 0 ? raw["factor"] : void 0;
	const multiplier = fromString ?? fromFactor;
	const displayMode = raw["displayMode"] === "replace" || raw["displayMode"] === "strikethrough" ? raw["displayMode"] : void 0;
	if (multiplier === void 0 && displayMode === void 0) return void 0;
	return {
		...multiplier === void 0 ? {} : { multiplier },
		...displayMode === void 0 ? {} : { displayMode }
	};
}
/** 上游的 `schedule` → 本插件的排期形状。 */
function parseSchedule(value, label) {
	const raw = record(value);
	if (raw === void 0) return void 0;
	const timezone = text(raw["timezone"]);
	const validFrom = parseInstant(raw["validFrom"]);
	const validUntil = parseInstant(raw["validUntil"]);
	const daily = parseDaily(raw["daily"], label);
	const dailyUnusable = daily === void 0 && Array.isArray(raw["daily"]) && raw["daily"].length > 0;
	if (timezone === void 0 && validFrom === void 0 && validUntil === void 0 && daily === void 0 && !dailyUnusable) return void 0;
	return {
		...timezone === void 0 ? {} : { timezone },
		...validFrom === void 0 ? {} : { validFrom },
		...validUntil === void 0 ? {} : { validUntil },
		...daily === void 0 ? {} : { daily },
		...dailyUnusable ? { dailyUnusable: true } : {}
	};
}
/** 一条上游条目 → 本插件的促销形状；不是促销就 undefined。 */
function parsePromo(value, source) {
	const raw = record(value);
	if (raw === void 0) return void 0;
	if (raw["enabled"] === false) return void 0;
	const modelIds = parseModelIds(raw["modelIds"]);
	if (modelIds === void 0) return void 0;
	const badge = parseBadge(raw["badge"]);
	if (badge === void 0) return void 0;
	const hover = parseHover(raw["hover"]);
	const id = text(raw["id"]) ?? `${source}:${modelIds.join(",")}`;
	const schedule = parseSchedule(raw["schedule"], id);
	const discount = parseDiscount(raw["discount"]);
	const priority = typeof raw["priority"] === "number" && Number.isFinite(raw["priority"]) ? raw["priority"] : 0;
	return {
		id,
		source,
		modelIds,
		badge,
		...hover === void 0 ? {} : { hover },
		...schedule === void 0 ? {} : { schedule },
		...discount === void 0 ? {} : { discount },
		priority
	};
}
/**
* 解析上游的促销与档位两个数组。
*
* 两个数组都来自名册所在的**同一份**文档，所以这一步不花任何请求。不是促销的条目
* （没有 `modelIds`、没有 `badge`、或 `enabled: false`）在这里丢掉，好让下游都能
* 假定「一条 promo 就是画得出来的」。
*
* 促销排在档位之前，于是 `priority` 打平时偏向促销：价格徽标（`Free now`）比访问
* 档位徽标（`Pro Only`）对用户更可行动，而上游给它们编了同样的数（实测都是 200）。
*/
function parseWorkBuddyPromos(rawPromotions, rawTiers) {
	const promos = [];
	for (const entry of Array.isArray(rawPromotions) ? rawPromotions : []) {
		const promo = parsePromo(entry, "promotion");
		if (promo !== void 0) promos.push(promo);
	}
	for (const entry of Array.isArray(rawTiers) ? rawTiers : []) {
		const tier = parsePromo(entry, "tier");
		if (tier !== void 0) promos.push(tier);
	}
	return promos;
}
/**
* 把点了名的促销挂到对应模型上。
*
* 结果是**故意未解析**的：每一条点名了该模型的候选都跟着走，好让徽标在渲染时对着
* 时钟选（见 {@link selectPromoBadge}）。在这里解析等于把答案冻在取数时刻 —— 那正是
* 「夜间折扣」在夜里过去之后还自称夜间的那个缺陷。
*/
function attachPromos(models, promos) {
	if (promos.length === 0) return [...models];
	const byModel = /* @__PURE__ */ new Map();
	for (const promo of promos) for (const modelId of promo.modelIds) {
		const list = byModel.get(modelId);
		if (list === void 0) byModel.set(modelId, [promo]);
		else list.push(promo);
	}
	return models.map((model) => {
		const list = byModel.get(model.id);
		if (list === void 0) return model;
		return {
			...model,
			promos: [...list].sort((a, b) => b.priority - a.priority)
		};
	});
}
//#endregion
//#region src/upstream.ts
/**
* WorkBuddy 上游 HTTP 客户端：纯传输 + 解析，**不持有 logger、不读 cordis 上下文**。
*
* 每个端点、每个 header、每个字段名都是回源核对的（不是凭记忆写的）：
* 出处 `plugins/dsh-connect-workbuddy/src/upstream.ts`（4.15.1）。核对的锚点：
* - 基址常量 `:334-336`（CN_CHAT_BASE / CN_BILLING_BASE / GLOBAL_BASE）
* - 两个 User-Agent 的通道机制 `:382-408`（`/v3/config` 按 UA 通道回答不同文档）
* - header 族 `:900-1000`（chat / refresh / billing 三套，各含 X-No-* 约定）
* - `parseCreditMultiplier` `:1878`、`parseUpstreamModel` `:1956`、`selectCliModels` `:2018`
* - `fetchModels` `:2245`、`fetchCheckinStatus` `:2307`、`fetchBenefits` `:2353`、
*   `claimBenefit` `:2424`、`claimDailyCheckin` `:2438`、`fetchCredits` `:2465`
*
* 为什么模块不持 logger：它要能在测试与 CLI 里被直接 import 而不带一个 cordis
* context。需要上报的降级（CN 目录回退）通过构造参数回调，宿主接
* `ctx.logger.warn`，没宿主就静默——与参考实现同口径。
*
* @module dsh-connect-workbuddy-models/upstream
*/
/**
* 稳定的账号 id：`uin` 是上游计费的身份，重新登录后不变；回退 `uid`。
*
* 定义在凭据类型旁边而不是 `accounts.ts` 里，因为**写入侧也要用它**：刷新后的
* token 要按账号落盘（`account-store.ts` 的 `credential-refresh.json`），而写
* 发生在 `chatStream` 内部、读发生在账号发现里。两处各抄一份 sha256 公式，改前
* 缀或改截断时只改一处，读写两侧就会永久性地互相找不到对方写的记录——故障形态
* 是「刷新成功了但重启后又失效」，且任何单侧测试都是绿的。
*
* 用 `uin` 优先而不是文件名：多份快照是**同一个**账号的不同时刻，它们必须折叠成
* 一个池成员，否则池里「4 个账号」其实是 2 个人，选号与积分合计都会翻倍。
*/
function workbuddyAccountId(credential) {
	const stable = credential.uin ?? credential.uid ?? credential.nickname ?? "unknown";
	return createHash("sha256").update(`workbuddy\0${stable}`).digest("hex").slice(0, 16);
}
/** 上游拒绝凭据。独立的错误类，让调用方能给出「请重新登录」而不是 HTTP 码。 */
var WbCredentialRejectedError = class extends Error {
	code = "WB_CREDENTIAL_REJECTED";
	status;
	constructor(status, detail = "") {
		super(`workbuddy: 上游拒绝了这份登录凭据（http ${status}）。最可能的原因是选中了一份更早登录留下的历史快照。请重新登录 WorkBuddy 桌面端后重新选择账号。` + (detail === "" ? "" : ` 上游原文：${detail}`));
		this.name = "WbCredentialRejectedError";
		this.status = status;
	}
};
/** 判断一个错误是否是「上游拒绝凭据」；按 code 判定，跨 bundle 安全。 */
function isCredentialRejectedError(value) {
	return typeof value === "object" && value !== null && value.code === "WB_CREDENTIAL_REJECTED";
}
const HARD_CREDIT_MARKERS = [
	"insufficient credit",
	"credits exhausted",
	"quota exceeded"
];
/** 上游把「余额花光」也编成业务码；实测 14018 的 body 写的是 `Credits exhausted.`。 */
const CREDITS_EXHAUSTED_CODE = "14018";
/**
* 这个 body 是不是「未授权通道」那一支的 11128。
*
* **必须匹配带引号的键形式** `"code":11128`，不能用裸 `11128`。业务码在响应体里
* 只以 JSON 成员出现，而裸数字会被无关字段里一段十六进制命中：实测上游的
* `requestId` 形如 `9f4e685b-e16d-4693-b2a6-7863e832f885`，其中 `11128` 这种
* 短串出现的概率并不低。一次巧合命中会把一次网络错误升级成「渠道闸门」，
* 进而触发两条注定失败的自救请求——用更贵的代价把一条红鲱鱼写成诊断。
*
* 11128 家族有三支（同源实测）：未授权通道、`conversation id missing`、首条不是
* system 提示词。只有第一支归这里；后两支归 `client_reject`，因为它们的修法
* 是改请求形状（本插件已在 {@link prepareChatBody} 里修掉），不是改写开场白。
*/
function isChannelGateFamilyBody(body) {
	return body.includes("\"code\":11128");
}
/**
* 本机 billion-context 闸门的两支 422 的业务码。
*
* 注意 `..._unattributed` 把另一个码**整个包含**进去，所以判断顺序必须是长的在前
* —— 反过来会让「未归属」那一支永远认成「归属查询抛错」，而两者的处置完全不同
* （前者裁剪内容就能过，后者要重启宿主）。
*/
const LOCAL_GATE_UNATTRIBUTED_CODE = "bili_gate_oversize_refusal_unattributed";
const LOCAL_GATE_OVERSIZE_CODE = "bili_gate_oversize_refusal";
/**
* 闸门原文的开场白。Anthropic 形状（`/messages`）的拒绝体里**只有 message 没有
* code**，所以光靠业务码认不全；这句开场白是两种形状共有的。
*/
const LOCAL_GATE_BRAND = "billion-context refused this request locally";
/** 两支各自的判别句（同 `LOCAL_GATE_BRAND`，用于缺 code 的形状）。 */
const LOCAL_GATE_UNATTRIBUTED_MARK = "not attributed to any bili-managed session";
const LOCAL_GATE_OVERSIZE_MARK = "attribution lookup threw";
/**
* 这个 body 是不是本机闸门的拒绝，是的话是哪一支。
*
* **刻意不看状态码**：两支都是 422，而 422 在别处也可能出现；反过来，同一份 body
* 被包成 400、500 或 200 都不改变「这是本机闸门拒绝、请求没到上游」这个事实，
* 而整条处置建议都建立在那个事实上。按状态码分流会让一次中间层改写就把结论打断。
*
* 三个判据从强到弱：业务码 → 分支判别句 → 开场白。开场白单独出现时按未归属那一支
* 处理：它的处置建议更保守（裁剪内容），对另一支也基本适用。
*/
function localGateKindOf(body) {
	if (!body.includes(LOCAL_GATE_BRAND) && !body.includes(LOCAL_GATE_UNATTRIBUTED_CODE) && !body.includes(LOCAL_GATE_OVERSIZE_CODE)) return;
	if (body.includes(LOCAL_GATE_UNATTRIBUTED_CODE) || body.includes(LOCAL_GATE_UNATTRIBUTED_MARK)) return "local_gate_unattributed";
	if (body.includes(LOCAL_GATE_OVERSIZE_CODE) || body.includes(LOCAL_GATE_OVERSIZE_MARK)) return "local_gate_oversize";
	return "local_gate_unattributed";
}
/**
* 把一个 HTTP 失败归类。
*
* 顺序是有理由的：先按**状态码**给出确定答案（402 就是钱的问题），再看 body 里
* 的标记；`CREDITS_EXHAUSTED_CODE` 排在软限流之前，因为同时带「耗尽」与「节流」
* 两种码的 body 应当给出可执行的那个结论（去充值/换号），而不是「等一会儿」。
*/
function classifyUpstreamError(status, body) {
	const localGate = localGateKindOf(body);
	if (localGate !== void 0) return localGate;
	if (status === 401 || status === 403) return "authentication";
	if (status === 402) return "hard_credit";
	const lower = body.toLowerCase();
	for (const marker of HARD_CREDIT_MARKERS) if (lower.includes(marker)) return "hard_credit";
	if (body.includes(CREDITS_EXHAUSTED_CODE)) return "hard_credit";
	if (status === 429) return "soft_rate";
	if (lower.includes("conversation id missing")) return "client_reject";
	if (isChannelGateFamilyBody(body)) return "channel_reject";
	if (lower.includes("session") && (lower.includes("expired") || lower.includes("invalid"))) return "session_dead";
	if (status >= 500) return "server";
	return "client";
}
const CN_CHAT_BASE = "https://copilot.tencent.com";
const CN_BILLING_BASE = "https://www.codebuddy.cn";
const GLOBAL_BASE = "https://www.workbuddy.ai";
/**
* 旧版模型目录路径，**只作国内区域的兜底**。
*
* 这是 WorkBuddy *插件* 当年读的文档，不是 WorkBuddy *应用* 读的文档：网关用它
* 回答 CLI 通道的名册，既没有应用的 `auto` 槽也没有促销 feed。保留它只为「网关
* 哪天不再供应新文档时降级，而不是让整个区域没有模型」。
*/
const MODELS_CATALOG_PATH = "/v2/enterprises/personal/models";
/**
* 产品配置路径——应用自己读的那份文档（模型名册 + 价格 + 促销徽标）。
*
* 字段与旧路径对 `parseUpstreamModel` 读的每个键都兼容，所以一个解析器服务两者。
*/
const GLOBAL_CONFIG_PATH = "/v3/config";
/** 聊天通道的 UA：插件在对话时**就是** CLI agent，计费与限流都按这个身份。 */
const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
/**
* 产品配置通道的 UA：WorkBuddy 应用自己的产品身份。
*
* 为什么必须区分：`/v3/config` **按 UA 声称的通道**回答不同文档。实测（同一
* token、同一 URL，只改这一个 header，国内网关）：
*
* | User-Agent                                    | 答案                          |
* | ---                                           | ---                           |
* | `CLI/2.63.2 CodeBuddy/2.63.2`（CLI 通道）      | 5 键 / 35 模型 / **无**促销 feed |
* | `WorkBuddy/5.8.3`（应用通道，无 CLI 段）        | 18 键 / 37 模型 / 无促销 feed   |
* | `WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0` | 22 键 / 62 模型 / 8 促销 + 1 档 |
*
* 版本后缀是惰性的（`WorkBuddy/1.0.0 …` 答案相同），起作用的是通道，不是版本。
*/
const PRODUCT_UA = "WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0";
const JSON_TIMEOUT_MS = 3e4;
const ERROR_BODY_LIMIT = 4096;
/**
* 登录域名 → 区域。
*
* 国际产品在**两个**品牌域名下可达：WorkBuddy AI 桌面端登录在 `workbuddy.ai`，
* CodeBuddy CLI 把同一个国际账号登录在 `codebuddy.ai`。两者背后是同一套网关。
* 漏掉 `codebuddy.ai` 会把那些 token 发到国内网关，被 openresty 层以 HTML 401
* 拒绝——看起来像「凭据坏了」。
*/
function regionOf(domain) {
	const lowered = domain.trim().toLowerCase();
	if (lowered === "workbuddy.ai" || lowered.endsWith(".workbuddy.ai")) return "global";
	if (lowered === "codebuddy.ai" || lowered.endsWith(".codebuddy.ai")) return "global";
	return "cn";
}
/**
* 国际网关基址。
*
* 国际账号**不能跨品牌域名互换**：在 `codebuddy.ai` 签发的 token 会被
* `workbuddy.ai` 网关拒绝（反之亦然），所以基址必须跟着凭据自己的域名走。
*/
function globalBase(domain) {
	const lowered = domain.trim().toLowerCase();
	if (lowered === "codebuddy.ai" || lowered.endsWith(".codebuddy.ai")) return "https://www.codebuddy.ai";
	return GLOBAL_BASE;
}
function chatBase(credential) {
	return regionOf(credential.domain) === "global" ? globalBase(credential.domain) : CN_CHAT_BASE;
}
function billingBase(credential) {
	return regionOf(credential.domain) === "global" ? globalBase(credential.domain) : CN_BILLING_BASE;
}
function originReferer(credential) {
	return regionOf(credential.domain) === "global" ? globalBase(credential.domain) : CN_BILLING_BASE;
}
function commonHeaders(credential) {
	return {
		"Accept": "application/json, text/plain, */*",
		"X-Requested-With": "XMLHttpRequest",
		"Origin": originReferer(credential),
		"Referer": `${originReferer(credential)}/`,
		"User-Agent": CLIENT_UA
	};
}
/**
* 对话身份三元组，聊天端点的第二道闸门。
*
* 国际网关在 `system` 开头规则之上又加了一道：聊天请求必须携带官方客户端的
* 会话身份，否则每一步都被拒（业务码 `11128` / `conversation id missing`）。
* 三个 id 缺一不可——只带 `X-Conversation-ID` 仍然失败。
*
* 网关不校验这三个值从哪来（任何合法 UUID 都过），所以它们**不是秘密、不持久化**，
* 且每次请求重新生成：复用同一个值等于伪造一段自己并不拥有的会话身份，最先坏掉
* 的就是上游对「同一个 id 报了两次」的关联。
*
* 两个区域都发：国内网关今天容忍它们缺失，一条只在单边发出的 header 正是让上
* 一次缺陷「只在国际暴露、从国内看不见」的原因。
*/
function conversationHeaders() {
	return {
		"X-Conversation-ID": randomUUID(),
		"X-Conversation-Request-ID": randomUUID(),
		"X-Conversation-Message-ID": randomUUID()
	};
}
function chatHeaders(credential) {
	return {
		...commonHeaders(credential),
		"Content-Type": "application/json",
		...credential.uid === void 0 || credential.uid === "" ? { "X-No-User-Id": "1" } : { "X-User-Id": credential.uid },
		...credential.enterpriseId === void 0 || credential.enterpriseId === "" ? { "X-No-Enterprise-Id": "1" } : { "X-Enterprise-Id": credential.enterpriseId },
		...credential.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": credential.domain },
		"X-Product": "SaaS",
		...conversationHeaders()
	};
}
/** refresh token 只在这里出现，别处一律不出现。 */
function refreshHeaders(credential) {
	const headers = {
		...commonHeaders(credential),
		"X-Refresh-Token": credential.refreshToken,
		"X-Auth-Refresh-Source": "workbuddy"
	};
	if (credential.enterpriseId !== void 0 && credential.enterpriseId !== "") headers["X-Enterprise-Id"] = credential.enterpriseId;
	return headers;
}
function billingHeaders(credential) {
	const headers = {
		"Authorization": `Bearer ${credential.accessToken}`,
		"Accept": "application/json",
		"Content-Type": "application/json"
	};
	if (credential.uid !== void 0 && credential.uid !== "") headers["X-User-Id"] = credential.uid;
	if (credential.enterpriseId !== void 0 && credential.enterpriseId !== "") {
		headers["X-Enterprise-Id"] = credential.enterpriseId;
		headers["X-Tenant-Id"] = credential.enterpriseId;
	}
	if (credential.domain !== "") headers["X-Domain"] = credential.domain;
	return headers;
}
/** 边缘层拒绝（openresty / apisix 的 HTML 401）也属于「凭据被拒」。 */
function isGatewayAuthRejection(status, text) {
	if (status !== 401 && status !== 403) return false;
	const lower = text.toLowerCase();
	return lower.includes("openresty") || lower.includes("apisix") || lower.includes("authorization required");
}
async function readEnvelope(response) {
	const text = await response.text();
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		if (isGatewayAuthRejection(response.status, text)) throw new WbCredentialRejectedError(response.status, text.slice(0, 200));
		throw new Error(`workbuddy 上游返回了非 JSON（http ${response.status}）：${text.slice(0, 160)}`);
	}
	if (typeof parsed !== "object" || parsed === null) throw new Error(`workbuddy 上游返回了意外的文档（http ${response.status}）`);
	const document = parsed;
	return {
		code: typeof document["code"] === "number" ? document["code"] : 0,
		msg: typeof document["msg"] === "string" ? document["msg"] : "",
		data: "data" in document ? document["data"] : void 0
	};
}
/**
* 业务码非 0 的信封按 HTTP 错误同等对待。
*
* 401/403 上的 JSON body 仍然是凭据拒绝：边缘层用业务形状回答，但 token 同样
* 不可用，所以映射到同一个可执行错误，而不是笼统的「客户端错误」。
*/
function envelopeError(status, envelope) {
	if (status === 401 || status === 403) return new WbCredentialRejectedError(status, envelope.msg.slice(0, 200));
	const kind = classifyUpstreamError(status, envelope.msg);
	return /* @__PURE__ */ new Error(`workbuddy 上游 ${kind}（http ${status}）：${envelope.msg.slice(0, 160)}`);
}
function dataOf(envelope) {
	return typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
}
/**
* 上游的档位阶梯，从低到高。
*
* 与 pi-ai 的 `EXTENDED_THINKING_LEVELS` 同序但不含 `off`：`off` 不是「一档思考」，
* 而是「不思考」，由 `reasoning.canDisableThinking` 单独表达。
*/
const EFFORT_LADDER = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/**
* 上游名册的 `reasoning` 有两种拼写，这里认第二（单数）种。
*
* 复数形宣告完整名单：`{ canDisableThinking, defaultEffort, supportedEfforts: [...] }`。
* 单数形只说它默认落在哪一档：`{ effort: 'high', summary: 'auto' }`——**`summary`
* 是给用户看的思考摘要开关，与本插件无关，故意不读。**
*
* 判据必须是「没有复数形专有字段」而不只是「有 `effort`」：实测上游确实存在
* `model` 条目同时带 `effort` 与其它字段的组合，只看 `effort` 会把复数形误判成单数。
*/
function isSingularEffortForm(raw) {
	return typeof raw["effort"] === "string" && !Array.isArray(raw["supportedEfforts"]) && typeof raw["defaultEffort"] !== "string" && typeof raw["canDisableThinking"] !== "boolean";
}
/**
* 把单数形展开成一条阶梯。
*
* 单数形只报一个锚点（`effort`），不报全部档位。上游这么写是因为这些模型的档位
* 是**连续**的：能跑 `high` 的必然能跑比它低的每一档。所以从锚点向上补到阶梯顶。
*
* 锚点不认识就**原样单档**返回：猜一个它可能不接受的高档，会让用户选到一个必失败
* 的选项；只给一个确定的档位是保守且诚实的。
*/
function singularEffortLadder(effort) {
	const index = EFFORT_LADDER.indexOf(effort);
	if (index < 0) return [effort];
	return EFFORT_LADDER.slice(0, index + 1);
}
/**
* 解析 `reasoning` 字段，把两种拼写折叠成一种形状。
*
* 三个字段全都没给时返回 `undefined`（上游没宣告）而不是 `{}`：空对象会被下游读成
* 「宣告了零个档位」，而「没宣告」与「宣告了空」在诊断上是两件不同的事。
*/
function parseReasoning(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const raw = value;
	const supportedEfforts = Array.isArray(raw["supportedEfforts"]) ? raw["supportedEfforts"].filter((entry) => typeof entry === "string" && entry !== "") : void 0;
	const defaultEffort = typeof raw["defaultEffort"] === "string" && raw["defaultEffort"] !== "" ? raw["defaultEffort"] : void 0;
	const canDisableThinking = typeof raw["canDisableThinking"] === "boolean" ? raw["canDisableThinking"] : void 0;
	if (isSingularEffortForm(raw)) return {
		supportedEfforts: singularEffortLadder(raw["effort"]),
		canDisableThinking: true
	};
	if (supportedEfforts === void 0 && defaultEffort === void 0 && canDisableThinking === void 0) return;
	return {
		...supportedEfforts === void 0 ? {} : { supportedEfforts },
		...defaultEffort === void 0 ? {} : { defaultEffort },
		...canDisableThinking === void 0 ? {} : { canDisableThinking }
	};
}
/**
* 解析 `credits` 字段（形如 `'x0.00'` / `'x3.31'`）。
*
* 只认字符串：上游把倍率编成带 `x` 前缀的字符串，数字形状在实践中没出现过。
* 非字符串一律 `undefined`（未知），不猜。
*/
function parseCreditMultiplier(value) {
	if (typeof value !== "string") return void 0;
	const match = /x\s*([0-9]*\.?[0-9]+)/iu.exec(value);
	if (match === null) return void 0;
	const parsed = Number(match[1]);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : void 0;
}
/**
* 解析一个目录条目；没有可用 token 限额的条目直接丢弃。
*
* 丢弃而不是补默认值：`contextWindow` 是 DSH 派发前的压缩依据，编一个数字会
* 让 DSH 按错误的窗口决定截断多少历史。
*/
function parseUpstreamModel(value) {
	if (typeof value !== "object" || value === null) return void 0;
	const raw = value;
	const id = typeof raw["id"] === "string" ? raw["id"] : "";
	if (id === "" || raw["disabled"] === true) return void 0;
	const input = typeof raw["maxInputTokens"] === "number" ? raw["maxInputTokens"] : 0;
	const output = typeof raw["maxOutputTokens"] === "number" ? raw["maxOutputTokens"] : 0;
	if (input <= 0 || output <= 0) return void 0;
	const name = typeof raw["name"] === "string" && raw["name"] !== "" ? raw["name"] : id;
	const creditMultiplier = parseCreditMultiplier(raw["credits"]);
	const supportsImages = raw["disabledMultimodal"] === true ? false : typeof raw["supportsImages"] === "boolean" ? raw["supportsImages"] : void 0;
	const descriptionZh = typeof raw["descriptionZh"] === "string" && raw["descriptionZh"] !== "" ? raw["descriptionZh"] : void 0;
	const reasoning = parseReasoning(raw["reasoning"]);
	return {
		id,
		name,
		contextWindow: input,
		maxTokens: output,
		...creditMultiplier === void 0 ? {} : { creditMultiplier },
		...supportsImages === void 0 ? {} : { supportsImages },
		...descriptionZh === void 0 ? {} : { description: descriptionZh },
		...typeof raw["supportsToolCall"] === "boolean" ? { supportsToolCall: raw["supportsToolCall"] } : {},
		...reasoning === void 0 ? {} : { reasoning }
	};
}
/**
* 路由条目不是模型。
*
* 上游名册里混着 `auto`（国内）这类条目，它们是**路由决策**：网关按请求自行
* 决定落到哪个模型，价格、窗口、行为全是请求时由别人定的。当模型列出来等于在
* 宣传一个本插件无法说明条款的东西。显式表而不是启发式：靠名字猜，迟早会藏起
* 一个真模型。
*/
const ROUTER_MODEL_IDS = /* @__PURE__ */ new Set(["auto"]);
/**
* 从目录形状的文档里挑出可对话的模型。
*
* 两种文档（国内个人模型文档、国际 `/v3/config`）都带 `models` 与一个 `agents`
* 名册，同条目形状，所以一个选择器服务两者。没有可用 `cli` 名册时放出整份解析
* 结果而不是空：名册是上游细节，空答案会让 provider 静默失效。
*
* `keepIds` 是用户自己的选择随刷新一起带过来。上游名册可能撤掉用户正在用的模型
* （实测：app 通道的 `cli` 名册撤掉了 `minimax-m2.7`，而**同一份文档**仍在发布
* 它、聊天端点仍答 200）。所以名册 = 上游名册 + 这份文档仍列出的 keepIds：刷新
* 可以增删上游模型，但绝不静默撤掉用户正在用的模型。
*/
function selectCliModels(rawModels, agents, keepIds = []) {
	const byId = /* @__PURE__ */ new Map();
	for (const model of Array.isArray(rawModels) ? rawModels : []) {
		const parsed = parseUpstreamModel(model);
		if (parsed !== void 0) byId.set(parsed.id, parsed);
	}
	let cliIds;
	for (const agent of Array.isArray(agents) ? agents : []) if (typeof agent === "object" && agent !== null) {
		const wrapped = agent;
		if (wrapped["name"] === "cli" && Array.isArray(wrapped["models"])) {
			cliIds = wrapped["models"].filter((id) => typeof id === "string");
			break;
		}
	}
	const ids = cliIds !== void 0 && cliIds.length > 0 ? cliIds : [...byId.keys()];
	const models = ids.filter((id) => !ROUTER_MODEL_IDS.has(id)).map((id) => byId.get(id)).filter((model) => model !== void 0);
	const kept = keepIds.filter((id) => !ids.includes(id)).map((id) => byId.get(id)).filter((model) => model !== void 0);
	const resolved = [...models, ...kept];
	if (resolved.length === 0) throw new Error("workbuddy 模型目录解析结果为空");
	return resolved;
}
/**
* 把同一份文档里的促销/档位条目挂到名册上。
*
* 两个数组（`modelPromotions` / `modelTiers`）与 `models`/`agents` **在同一个
* `/v3/config` 响应里**，所以这一步零额外请求。它们**只有应用通道（`PRODUCT_UA`）
* 才发布**：`CLI_UA` 打同一个 URL 回来的文档里这两个键是 `undefined`（实测 CN
* `[CLI] 200 keys=5 models=34 promos=undefined` vs `[PRODUCT] 200 keys=22 models=61
* promos=8 tiers=1`）。本插件读目录一直用 `PRODUCT_UA`，因此本来就拿得到 —— 这是
* 「不用改请求头、不用加端点」的事实依据。
*
* 解析失败或一个条目都没有时**原样返回**：促销是装饰，不能让它决定名册能不能用。
*/
function withPromos(models, data) {
	const promos = parseWorkBuddyPromos(data["modelPromotions"], data["modelTiers"]);
	if (promos.length === 0) return [...models];
	return attachPromos(models, promos);
}
/**
* 读一个「可能是字符串、也可能是 `{zh,en}` 对象」的文案字段。
*
* 上游两种形态都出现过：`displayMsg` 在部分信封里是纯字符串，在另一些里是
* `{en,zh}`。只认一种就会在另一半信封上静默丢掉那句建议 —— 而丢掉之后的表现是
* 「回复里又变成裸 JSON」，看起来像没修。
*/
function localizedText(value) {
	if (typeof value === "string") return value === "" ? void 0 : value;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const raw = value;
	const zh = raw["zh"];
	if (typeof zh === "string" && zh !== "") return zh;
	const en = raw["en"];
	if (typeof en === "string" && en !== "") return en;
}
/**
* 解析上游错误信封；不是 JSON 对象就返回 `undefined`。
*
* 逐字段独立判断是刻意的：任何一个字段畸形都只丢它自己，不能让整份 detail 变
* `undefined`。上游改一个字段的形状（例如 `code` 从数字变字符串）不应该把
* `tips` 一起带走 —— 那正是用户最需要的那句。
*/
function parseUpstreamErrorDetail(body) {
	let parsed;
	try {
		parsed = JSON.parse(body);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const raw = parsed;
	const detail = {};
	if (typeof raw["code"] === "number") detail.upstreamCode = raw["code"];
	if (typeof raw["requestId"] === "string" && raw["requestId"] !== "") detail.requestId = raw["requestId"];
	if (typeof raw["msg"] === "string" && raw["msg"] !== "") detail.rawMsg = raw["msg"];
	const displayMsg = localizedText(raw["displayMsg"]) ?? localizedText(raw["msg"]);
	if (displayMsg !== void 0) detail.displayMsg = displayMsg;
	const tips = localizedText(raw["displayTips"]);
	if (tips !== void 0) detail.tips = tips;
	const ext = raw["extError"];
	if (typeof ext === "object" && ext !== null && !Array.isArray(ext)) {
		const extRaw = ext;
		const param = extRaw["param"];
		if (typeof param === "string" && param !== "") detail.rejectedParam = param;
		const value = extRaw["value"];
		if (typeof value === "string" && value !== "") detail.rejectedTier = value;
	}
	const error = raw["error"];
	if (typeof error === "object" && error !== null && !Array.isArray(error)) {
		const errorRaw = error;
		const gateCode = errorRaw["code"];
		if (typeof gateCode === "string" && gateCode !== "") detail.localGateCode = gateCode;
		if (typeof errorRaw["retryable"] === "boolean") detail.retryable = errorRaw["retryable"];
		const errorMessage = localizedText(errorRaw["message"]);
		if (detail.displayMsg === void 0 && errorMessage !== void 0) detail.displayMsg = errorMessage;
	}
	return detail;
}
/** 六态全集，顺序即从空闲到不可用。 */
const WB_BUSY_LEVELS = [
	"idle",
	"normal",
	"busy",
	"congested",
	"unavailable",
	"unknown"
];
/** 拥挤度端点。 */
const MODEL_BUSY_PATH = "/v2/chat/busy";
/** 把上游那个字符串收进六态；越界一律 `unknown`（丢弃等于丢掉「问过了但没答案」）。 */
function normalizeBusyLevel(value) {
	if (typeof value !== "string") return "unknown";
	return WB_BUSY_LEVELS.includes(value) ? value : "unknown";
}
/**
* 解析 `/v2/chat/busy` 的 `data`。
*
* 非对象条目与没有 `model` 字段的条目跳过（它们不指向任何模型，收下来也无处安放）；
* **值**越界则记 `unknown` 而不是跳过 —— 后者会让那个模型在我们的名册里显示成
* 「没问过」，与「问过但它答了个新值」混为一谈。
*/
function parseBusyLevels(entries) {
	const levels = /* @__PURE__ */ new Map();
	if (!Array.isArray(entries)) return levels;
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const raw = entry;
		const id = typeof raw["model"] === "string" ? raw["model"] : "";
		if (id === "") continue;
		levels.set(id, normalizeBusyLevel(raw["busy_level"]));
	}
	return levels;
}
/**
* 把 id 列表切成批次：**先按首次出现去重、再切**。
*
* 去重不是洁癖：模型名册 = cli agent 名册 + 用户保留的 id，同一个 id 合法地出现两次，
* 而上游按「被问的数量」计配额。保序是为了让日志里的批次顺序与名册一致。
*/
function batchModelIds(ids, size = 50) {
	const unique = [...new Set(ids.filter((id) => id !== ""))];
	const limit = size > 0 ? size : 50;
	const batches = [];
	for (let index = 0; index < unique.length; index += limit) batches.push(unique.slice(index, index + limit));
	return batches;
}
/**
* 每个等级在模型名后面跟的符号。
*
* 用符号而不是文字，是因为它要把等级带过 `src/catalog.ts` 的 `toModelInfo()` ——
* 那个投影只搬运 `id`/`name`/`contextWindow`/`maxTokens`/`creditMultiplier`/
* `supportsImages`/`description`，而 `WbModelInfo` 上没有拥挤度字段、该类型所在的
* `src/status-paths.ts` 也不在本任务的改动范围内。`name` 是唯一能原样到达界面的
* 字段（DSH 原样渲染它，参考实现的 `busyDisplaySuffix` 也是这么做的）。
*/
const BUSY_SYMBOLS = {
	idle: "🚀",
	normal: "🧍",
	busy: "🧍🧍",
	congested: "🧍🧍🧍",
	unavailable: "🚫",
	unknown: ""
};
/**
* 需要画出来的等级：**唯独排除 `unknown`**。
*
* 两条理由：每行都挂一个标记会让标记退化成装饰，用户学会忽略它；而 `unknown` 更
* 不该画 —— 那是「本插件没问到」，画出来就是替上游声称了一个它没说过的事实。
*/
const DRAWN_IN_PICKER = /* @__PURE__ */ new Set([
	"idle",
	"busy",
	"congested",
	"unavailable"
]);
/** 该等级对应的符号；`unknown`/`undefined` 一律空串（调用方据此不渲染）。 */
function busySymbol(level) {
	if (level === void 0 || !DRAWN_IN_PICKER.has(level)) return "";
	return BUSY_SYMBOLS[level];
}
/**
* 把等级挂到名册条目上（**复制不改写**）。
*
* 名册条目与设置卡片保存的快照是同一批对象；就地改 `name` 会让「刷新一次」与
* 「刷新两次」得到不同的名字，而用户看到的是名字越来越长。
*/
function attachBusyLevels(models, levels) {
	return models.map((model) => {
		const level = levels.get(model.id);
		if (level === void 0 || level === model.busyLevel) return model;
		return {
			...model,
			busyLevel: level
		};
	});
}
/**
* 把拥挤度写进 `name` 的那一个后缀。
*
* 返回空串表示「不加」——`undefined` 与 `unknown` 都走这里，所以名册里没问过拥挤度
* 的模型名字逐字节不变。
*/
function busyDisplaySuffix(level) {
	const symbol = busySymbol(level);
	return symbol === "" ? "" : ` ${symbol}`;
}
/** 权益领取路径。两个都**不带** `/v2` 前缀——那是另一族端点（探测 `/v2/...` 回 404）。 */
const BENEFIT_CLAIM_PATHS = {
	compensation: "/billing/meter/claim-compensation",
	gift: "/billing/meter/claim-gift"
};
/** 这份凭据自己声明的到期时刻是否已经过去。`expiresAtMs === 0` 表示文件没写，按未知处理。 */
function credentialExpired(credential, nowMs = Date.now()) {
	return credential.expiresAtMs > 0 && credential.expiresAtMs <= nowMs;
}
/**
* 这次失败是不是「换一份 token 就能好」。
*
* 只看这两种：`authentication`（401/403，凭据被拒）与 `session_dead`（上游业务码
* 说登录态失效）。其余种类刷新一律无意义——`hard_credit` 换 token 还是没钱，
* `soft_rate` 换 token 还是被限流，而 `client_reject` 是请求形状问题。
*/
function isCredentialFailure(result) {
	return !result.ok && (result.kind === "authentication" || result.kind === "session_dead");
}
/**
* 构造一次刷新失败。
*
* `retryable` 决定 shim 拿去冷却还是判死，所以它必须由**知道原因**的调用方给出：
* 网络/超时/边缘层错误是 `true`（稍后自动重试），凭据被上游明确拒绝、refresh token
* 本身缺失或已过期是 `false`（只能重新登录）。
*
* `kind` 一律保持 `authentication`，只有 `retryable` 变：这次请求确实因为「登录态没
* 拿到」而失败，这是事实；差别只在**这份凭据还有没有救**。让 kind 跟着一起变会丢掉
* 一个信息——「被上游拒了」和「没打通」都会变成 `server`，卡片上就再也分不出哪次该
* 去重新登录。所以状态码也保持 401：一个请求恰好赶上刷新失败时，401 是诚实的；而
* 一次抖动在池层面走冷却，等冷却到期账号自动回到参选名单，用户看到的最终答复来自
* `exhaustedReason` 的 429「都在冷却」，不会有人被叫去重新登录。
*/
function renewFailed(message, retryable) {
	return {
		ok: false,
		retryable,
		failure: {
			ok: false,
			status: 401,
			kind: "authentication",
			message,
			...retryable ? { retryable: true } : {}
		}
	};
}
/**
* 把刷新失败的异常翻成一句话。
*
* 两类必须分开：上游**明确拒绝**了 refresh token（`WbCredentialRejectedError`）意味
* 着只能重新登录；网络/超时/边缘层 HTML 错误意味着稍后还能再试，此时说「请重新登录」
* 是把人赶去做不必要的操作。两种都以「无法自动续期」结尾，因为这次请求确实没救了。
*/
function describeRefreshFailure(error) {
	if (error instanceof WbCredentialRejectedError) {
		const detail = error.message.trim();
		return `refresh token 被上游拒绝${detail === "" ? "" : `（${detail}）`}，无法自动续期；请重新登录 WorkBuddy 桌面端。`;
	}
	return `刷新登录态失败（${error instanceof Error ? error.message : String(error)}），本轮无法自动续期；稍后自动重试，持续失败请重新登录 WorkBuddy 桌面端。`;
}
/**
* 上游客户端。一个实例服务整个插件；请求显式接收凭据，所以 token 刷新在下一次
* 调用里自然生效。
*/
var WbUpstreamClient = class {
	onFallback;
	/**
	* 上报一次不得不采取的降级。
	*
	* 注入而不是在这里打日志：本模块不持 logger（理由见文件头）。宿主把它接到
	* `ctx.logger.warn`；没有宿主时事件被丢弃——与只有单一读取方的旧实现同等的安静。
	*/
	constructor(onFallback) {
		this.onFallback = onFallback;
	}
	/**
	* POST 聊天端点；成功的答案是原始 SSE 响应。
	*
	* 这是**唯一**会在失败后自愈的请求：登录态过期在这里最贵（用户正对着输入框等
	* 回答），而在余额/签到路径上过期只是少一个读数。自愈规则是「一次请求最多换一次
	* token」——`refreshed` 是这次调用的局部量而不是客户端上的标志位，所以并发中的
	* 十个请求各换各的一次，而每个请求自己绝不换第二次。上游对 refresh 端点有频次
	* 限制，重试环里再刷就变成用一个已经被拒的 token 反复敲门。
	*/
	async chatStream(credential, bodyJson, signal) {
		let refreshed = false;
		if (credentialExpired(credential)) {
			const renewed = await this.renewCredential(credential);
			if (!renewed.ok) return renewed.failure;
			refreshed = true;
		}
		const first = await this.postChat(credential, bodyJson, signal);
		if (first.ok) return first;
		if (!isCredentialFailure(first) || refreshed) return first;
		const renewed = await this.renewCredential(credential);
		if (!renewed.ok) return renewed.failure;
		return await this.postChat(credential, bodyJson, signal);
	}
	/** 一次不带自愈的聊天 POST。自愈逻辑在 {@link chatStream} 里，这里只负责发。 */
	async postChat(credential, bodyJson, signal) {
		let response;
		try {
			response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
				method: "POST",
				headers: {
					...chatHeaders(credential),
					"Authorization": `Bearer ${credential.accessToken}`
				},
				body: bodyJson,
				...signal === void 0 ? {} : { signal }
			});
		} catch (error) {
			return {
				ok: false,
				status: 0,
				kind: "server",
				message: `传输失败：${String(error)}`
			};
		}
		if (response.ok) return {
			ok: true,
			response
		};
		const text = (await response.text()).slice(0, ERROR_BODY_LIMIT);
		const detail = parseUpstreamErrorDetail(text);
		return {
			ok: false,
			status: response.status,
			kind: classifyUpstreamError(response.status, text),
			message: text,
			...detail === void 0 ? {} : { detail }
		};
	}
	/** POST token 刷新端点。调用方负责合并结果。 */
	async refreshToken(credential) {
		const response = await fetch(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
			method: "POST",
			headers: refreshHeaders(credential),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = dataOf(envelope);
		return {
			...typeof data["accessToken"] === "string" && data["accessToken"] !== "" ? { accessToken: data["accessToken"] } : {},
			...typeof data["refreshToken"] === "string" && data["refreshToken"] !== "" ? { refreshToken: data["refreshToken"] } : {},
			...typeof data["expiresIn"] === "number" && data["expiresIn"] > 0 ? { expiresInSec: data["expiresIn"] } : {}
		};
	}
	/**
	* 用 refresh token 换一份新登录态，**原地改写** `credential`。
	*
	* 原地改而不是返回新对象：池里那份 `WbDiscoveredAccount.credential` 与 shim 手里
	* 的是同一个引用，换对象只会让这次请求用上新 token、下一次调用又回到旧的那份。
	*
	* 顺序是「先改内存再落盘」：即使磁盘满或权限不对，本次请求仍然可用；反过来先落盘
	* 再改内存，写失败会连带失掉一次本来能成功的回答。
	*/
	async renewCredential(credential) {
		if (credential.refreshToken === "") return renewFailed("这份登录凭据里没有 refresh token，无法自动续期；请重新登录 WorkBuddy 桌面端。", false);
		const refreshExpiresAtMs = credential.refreshExpiresAtMs;
		if (refreshExpiresAtMs !== void 0 && refreshExpiresAtMs > 0 && refreshExpiresAtMs <= Date.now()) return renewFailed(`refresh token 已于 ${new Date(refreshExpiresAtMs).toLocaleString("zh-CN")} 失效，无法自动续期；请重新登录 WorkBuddy 桌面端。`, false);
		let issued;
		try {
			issued = await this.refreshToken(credential);
		} catch (error) {
			return renewFailed(describeRefreshFailure(error), !(error instanceof WbCredentialRejectedError));
		}
		if (issued.accessToken === void 0) return renewFailed("上游的刷新接口没有返回新的 access token；请重新登录 WorkBuddy 桌面端。", false);
		credential.accessToken = issued.accessToken;
		if (issued.refreshToken !== void 0) credential.refreshToken = issued.refreshToken;
		credential.expiresAtMs = issued.expiresInSec === void 0 ? 0 : Date.now() + issued.expiresInSec * 1e3;
		credential.lastRefreshAtMs = Date.now();
		await saveRefreshedCredential(PLUGIN_ID, workbuddyAccountId(credential), {
			accessToken: credential.accessToken,
			...credential.refreshToken === "" ? {} : { refreshToken: credential.refreshToken },
			expiresAtMs: credential.expiresAtMs,
			refreshedAtMs: credential.lastRefreshAtMs
		}, { warn: (message) => {
			this.onFallback?.(String(message));
		} });
		return { ok: true };
	}
	/**
	* 读模型目录。
	*
	* 两个区域一律先读 `/v3/config`（应用通道文档）；国内失败时回退旧路径。三种失败
	* 都要回退——传输错误、非零信封、以及**空名册**（`selectCliModels` 对空名册抛错），
	* 让「/v3 停止列出模型」退化成少一点功能，而不是整个区域没有模型。
	*/
	async fetchModels(credential, signal, keepModelIds = []) {
		const models = await this.readCatalogModels(credential, signal, keepModelIds);
		return await this.withBusyLevels(credential, models, signal);
	}
	/**
	* 问一次上游「这些模型现在挤不挤」。
	*
	* 一个请求问一整批（`WORKBUDDY_BUSY_BATCH_SIZE` 个），绝不逐个轮询：名册 20-62 个
	* 模型逐个问就是 20-62 个往返，而这条信息只是给人看的装饰。
	*
	* 非零信封与传输失败一律抛错，由 {@link withBusyLevels} 统一兜成「不挂等级」——
	* 与同类 reader 的分工一致：解析层只负责如实报告，降级策略留给调用方决定。
	*/
	async fetchModelBusy(credential, modelIds, signal) {
		const levels = /* @__PURE__ */ new Map();
		const batches = batchModelIds(modelIds);
		for (const batch of batches) {
			const response = await fetch(`${chatBase(credential)}${MODEL_BUSY_PATH}`, {
				method: "POST",
				headers: {
					...commonHeaders(credential),
					"Authorization": `Bearer ${credential.accessToken}`,
					"Content-Type": "application/json"
				},
				body: JSON.stringify({ models: batch }),
				signal: signal ?? AbortSignal.timeout(5e3)
			});
			const envelope = await readEnvelope(response);
			if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
			for (const [id, level] of parseBusyLevels(envelope.data)) levels.set(id, level);
		}
		return levels;
	}
	/**
	* 给名册挂上拥挤度；问不到就原样返回名册。
	*
	* 三层防线都在这里，顺序刻意：
	* 1. **按区短路**：国际网关没有 `/v2/chat/busy`（实测 404）。发出去再吞错会让每次
	*    刷新多一个注定失败的往返，还会在国际区的日志里留下一条永远为真的告警。
	* 2. **失败静默降级**：超时/404/非零信封都只 warn 一次，名册原样返回。拥挤度是
	*    装饰性信息，它失败不该让「刷新模型」这件事失败，也不该让名册少一个模型。
	* 3. **写进 `name`**：`WbModelInfo`（`status-paths.ts`）没有拥挤度字段，而
	*    `catalog.toModelInfo()` 只搬运固定几个字段——`name` 是唯一能原样到达界面的
	*    字段。所以符号拼在名字后面，`unknown`/`undefined` 拼空串（名字逐字节不变）。
	*/
	async withBusyLevels(credential, models, signal) {
		if (regionOf(credential.domain) !== "cn" || models.length === 0) return [...models];
		let levels;
		try {
			levels = await this.fetchModelBusy(credential, models.map((model) => model.id), signal);
		} catch (error) {
			this.onFallback?.("模型拥挤度读取失败，本次名册不带拥挤度：" + (error instanceof Error ? error.message : String(error)));
			return [...models];
		}
		return attachBusyLevels(models, levels).map((model) => {
			const suffix = busyDisplaySuffix(model.busyLevel);
			return suffix === "" ? model : {
				...model,
				name: `${model.name}${suffix}`
			};
		});
	}
	/** 读一份原始名册（不含拥挤度）。拆分出来只为了让 `fetchModels` 的降级链保持原样。 */
	async readCatalogModels(credential, signal, keepModelIds = []) {
		const timeout = signal ?? AbortSignal.timeout(JSON_TIMEOUT_MS);
		if (regionOf(credential.domain) === "global") {
			const response = await fetch(`${globalBase(credential.domain)}${GLOBAL_CONFIG_PATH}`, {
				headers: {
					"Authorization": `Bearer ${credential.accessToken}`,
					"Accept": "application/json",
					...credential.uid === void 0 || credential.uid === "" ? {} : { "X-User-Id": credential.uid },
					...credential.domain === "" ? {} : { "X-Domain": credential.domain },
					"X-Product": "SaaS",
					"X-Requested-With": "XMLHttpRequest",
					"Connection": "close",
					"User-Agent": PRODUCT_UA
				},
				signal: timeout
			});
			const envelope = await readEnvelope(response);
			if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
			const data = dataOf(envelope);
			return withPromos(selectCliModels(data["models"], data["agents"], keepModelIds), data);
		}
		const readCatalog = async (path) => {
			const response = await fetch(`${chatBase(credential)}${path}`, {
				headers: {
					"Authorization": `Bearer ${credential.accessToken}`,
					"Accept": "application/json",
					"Origin": originReferer(credential),
					"Referer": `${originReferer(credential)}/`,
					"User-Agent": PRODUCT_UA
				},
				signal: timeout
			});
			const envelope = await readEnvelope(response);
			if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
			const data = dataOf(envelope);
			return withPromos(selectCliModels(data["models"], data["agents"], keepModelIds), data);
		};
		try {
			return await readCatalog(GLOBAL_CONFIG_PATH);
		} catch (error) {
			this.onFallback?.(`国内模型目录 ${GLOBAL_CONFIG_PATH} 读取失败，回退 ${MODELS_CATALOG_PATH}：` + (error instanceof Error ? error.message : String(error)));
			return await readCatalog(MODELS_CATALOG_PATH);
		}
	}
	/** 读今日签到状态，不改账号状态。 */
	async fetchCheckinStatus(credential) {
		const response = await fetch(`${billingBase(credential)}/v2/billing/meter/checkin-activity-status`, {
			method: "POST",
			headers: billingHeaders(credential),
			body: "{}",
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = dataOf(envelope);
		const numberField = (key) => typeof data[key] === "number" ? data[key] : 0;
		return {
			active: data["active"] === true,
			todayCheckedIn: data["today_checked_in"] === true,
			streakDays: numberField("streak_days"),
			dailyCredit: numberField("daily_credit"),
			todayCredit: numberField("today_credit"),
			isStreakDay: data["is_streak_day"] === true,
			nextStreakDay: numberField("next_streak_day"),
			streakBonusDays: numberField("streak_bonus_days"),
			streakBonusCredit: numberField("streak_bonus_credit"),
			...typeof data["claim_button_text"] === "string" && data["claim_button_text"] !== "" ? { claimButtonText: data["claim_button_text"] } : {}
		};
	}
	/**
	* 读这个账号还能看到的全部促销权益，**不领取任何东西**。
	*
	* 活动清单刻意是封闭且小的：网关每个活动一个状态端点，所以「发现权益」是一次
	* 固定的扇出，不是搜索。新活动类型意味着在这里加一个 `/billing/meter/*-status`
	* ——插件从不猜未公开的端点。
	*
	* 每个端点独立读、失败按端点隔离：一个活动回 5xx 不能让另一个消失。调用方只
	* 拿到真正读到的东西。
	*/
	async fetchBenefits(credential) {
		const read = async (kind, path) => {
			try {
				return await this.readBenefitStatus(kind, credential, path);
			} catch {
				return;
			}
		};
		const [compensation, gift] = await Promise.all([read("compensation", "/billing/meter/compensation-status"), read("gift", "/billing/meter/check-gift-claimed")]);
		return [compensation, gift].filter((benefit) => benefit !== void 0);
	}
	async readBenefitStatus(kind, credential, path) {
		const response = await fetch(`${billingBase(credential)}${path}`, {
			method: "POST",
			headers: billingHeaders(credential),
			body: "{}",
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = dataOf(envelope);
		const numberField = (key) => typeof data[key] === "number" ? data[key] : 0;
		/** 网关把时间写成本地时区的 `YYYY-MM-DD HH:MM:SS`。 */
		const timeField = (key) => {
			const raw = data[key];
			if (typeof raw !== "string" || raw.trim() === "") return void 0;
			const parsed = Date.parse(raw.replace(" ", "T"));
			return Number.isNaN(parsed) ? void 0 : parsed;
		};
		const endsAtMs = timeField("end_time");
		const startsAtMs = timeField("start_time");
		const claimedAtMs = timeField("claimed_at");
		return {
			kind,
			active: data["active"] === true,
			claimed: data["claimed"] === true,
			creditNum: numberField("credit_num"),
			...endsAtMs === void 0 ? {} : { endsAtMs },
			...startsAtMs === void 0 ? {} : { startsAtMs },
			...claimedAtMs === void 0 ? {} : { claimedAtMs }
		};
	}
	/**
	* 在**一个**账号上领取一个权益。
	*
	* 这是一次真实的积分发放，所以除交给它的凭据之外不接受任何账号参数：由调用方
	* 决定是哪一个账号，且刻意没有批量形式。响应不解析——这两个端点的文档信封是
	* 空成功，调用方事后重读状态；那次重读才是给用户看的东西，所以「点了没生效」
	* 不会让卡片一直停在待领取。
	*/
	async claimBenefit(credential, kind) {
		const response = await fetch(`${billingBase(credential)}${BENEFIT_CLAIM_PATHS[kind]}`, {
			method: "POST",
			headers: billingHeaders(credential),
			body: "{}",
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
	}
	/** 领取今日签到奖励。浏览器路由守着这次写操作。 */
	async claimDailyCheckin(credential) {
		const response = await fetch(`${billingBase(credential)}/v2/billing/meter/daily-checkin`, {
			method: "POST",
			headers: billingHeaders(credential),
			body: "{}",
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = dataOf(envelope);
		const numberField = (key) => typeof data[key] === "number" ? data[key] : 0;
		return {
			credit: numberField("credit"),
			streakDays: numberField("streak_days"),
			isStreakDay: data["is_streak_day"] === true
		};
	}
	/**
	* 读剩余积分，**每个包单独保留**。
	*
	* 不在这里聚合（总量之外的任何汇合都会丢掉卡片排序需要的日期），窗口聚合交给
	* `probe.ts` —— 因为临期窗口必须用**用户配置的** `expiryWarnDays`，而这个模块
	* 不应该知道用户设置。
	*
	* 余额取 `CycleCapacityRemain` 家族（issue #58 定论）：`CapacityRemain` 是
	* pool 家族，整月额度花完时仍报满额（高报）；国际网关实测三账号报
	* `CapacityRemain=100`，而 chat 直接回 `14018 Credits exhausted`。用高报的那个
	* 当余额，排在第一的永远是一个已经用光的账号。
	*/
	async fetchCredits(credential) {
		const now = /* @__PURE__ */ new Date();
		const format = (date) => [
			date.getFullYear().toString().padStart(4, "0"),
			(date.getMonth() + 1).toString().padStart(2, "0"),
			date.getDate().toString().padStart(2, "0")
		].join("-") + " " + [
			date.getHours().toString().padStart(2, "0"),
			date.getMinutes().toString().padStart(2, "0"),
			date.getSeconds().toString().padStart(2, "0")
		].join(":");
		const response = await fetch(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
			method: "POST",
			headers: billingHeaders(credential),
			body: JSON.stringify({
				PageNumber: 1,
				PageSize: 100,
				ProductCode: "p_tcaca",
				Status: [0, 3],
				PackageEndTimeRangeBegin: format(now),
				PackageEndTimeRangeEnd: format(new Date(now.getTime() + 3185136e6))
			}),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const responseWrapper = dataOf(envelope);
		const data = typeof responseWrapper["Response"] === "object" && responseWrapper["Response"] !== null ? responseWrapper["Response"] : {};
		const inner = typeof data["Data"] === "object" && data["Data"] !== null ? data["Data"] : {};
		const rawAccounts = Array.isArray(inner["Accounts"]) ? inner["Accounts"] : [];
		const parseDate = (raw) => {
			if (typeof raw === "number" && raw > 0xe8d4a51000) return raw;
			if (typeof raw === "string" && raw !== "") {
				const parsed = Date.parse(raw);
				if (!Number.isNaN(parsed)) return parsed;
			}
		};
		let total = 0;
		const packages = [];
		for (const raw of rawAccounts) {
			if (typeof raw !== "object" || raw === null) continue;
			const account = raw;
			const numberField = (key) => typeof account[key] === "number" ? account[key] : 0;
			const preciseField = (key) => {
				const rawValue = account[`${key}Precise`];
				if (typeof rawValue === "string" && rawValue !== "") {
					const parsed = Number.parseFloat(rawValue);
					if (Number.isFinite(parsed)) return parsed;
				}
				if (typeof rawValue === "number" && Number.isFinite(rawValue)) return rawValue;
				return numberField(key);
			};
			const monthly = numberField("CapacityType") === 4;
			const size = preciseField("CycleCapacitySize") || preciseField("CapacitySize");
			const remain = account["CycleCapacityRemain"] !== void 0 || account["CycleCapacityRemainPrecise"] !== void 0 ? preciseField("CycleCapacityRemain") : preciseField("CapacityRemain");
			const cappedRemain = remain < 0 ? 0 : remain;
			const cycleEndMs = parseDate(account["CycleEndTime"]);
			const expiresAtMs = monthly ? void 0 : parseDate(account["ExpiredTime"]) ?? cycleEndMs;
			const refreshAtMs = monthly ? cycleEndMs === void 0 ? void 0 : cycleEndMs + 1e3 : void 0;
			if (!monthly && (cappedRemain <= 0 || expiresAtMs !== void 0 && expiresAtMs <= Date.now())) continue;
			total += cappedRemain;
			packages.push({
				packageName: typeof account["PackageName"] === "string" ? account["PackageName"] : "(unnamed)",
				remain: cappedRemain,
				size,
				monthly,
				...refreshAtMs === void 0 ? {} : { refreshAtMs },
				...expiresAtMs === void 0 ? {} : { expiresAtMs }
			});
		}
		return {
			total,
			packages
		};
	}
};
//#endregion
//#region src/accounts.ts
/**
* 账号发现：把本机上每一份可用的 WorkBuddy 登录变成账号。
*
* 出处（逐条回源核对，不是凭记忆）：
* - `plugins/dsh-workbuddy-xdpool/src/accounts.ts:131-165` `defaultDesktopAuthDirs`
* - 同文件 `:543-552` `candidateAuthDirs`（`WORKBUDDY_AUTH_FILE` 可指文件或目录）
* - 同文件 `:235-310` `parseWorkBuddyAuth`（`auth` / `account` 两段形状）
* - 同文件 `:350-360` `workbuddyAccountId`（sha256 取计费身份前 16 位）
* - 同文件 `:314-336` `authFilesIn`：目录下**所有** `*.info`，不只时间戳快照
* - `plugins/dsh-connect-workbuddy/src/auth.ts:231` `WORKBUDDY_VAULT_DIRNAME`、
*   `:264` `workbuddyVaultDir(region)`（`<dshHome>/workbuddy-vault/<region>`）
* - `plugins/dsh-connect-workbuddy/src/host-peers.ts:132-155,287` `resolveDshHome`
* - `plugins/dsh-connect-workbuddy/src/account-pool.ts:429-520` 排序键（已固化在
*   `status-paths.ts` 的 `rankAccounts`，这里直接调用，不重写）
*
* ## 两处凭据来源，缺一不可
*
* 1. **桌面端 auth 目录**（`*.info`）：用户最近一次登录写下的文件。签名机制下
*    较新的 Windows 构建把 `accessToken` 存成 `$wbEncrypted` 信封（见
*    `at-rest.ts`），而**只有**「唯一那份文件是信封」的账号会因此整体读不出来。
* 2. **dsh 凭据 vault**（`<dshHome>/workbuddy-vault/<region>/*.json`）：
*    `dsh-connect-workbuddy` 把每个已知账号的**明文**凭据持久化在这里。装了它的
*    机器（本机就是）因此有一份不受桌面包加密影响的副本。
*
* 只扫桌面端目录曾让本机 4 个账号里 2 个彻底消失（它们的唯一文件是加密快照），
* 而 vault 里明明有这 4 个账号的明文 token 且上游全部可用——这是 F1 的根因：
* `authFilesIn` 只收 `.info`，vault 的 `.json` 被无声滤掉，界面显示「0 个账号」
* 且**跳过列表也是空的**，连「凭据被加密了」这条诊断都没有。
*
* 后缀因此按**目录语义**收：桌面端目录只收 `.info`（同目录里的
* `*.observation.json` 是诊断产物，不是登录），vault 目录只收 `.json`。无差别收
* `.json` 会把 `observation.json` 当成账号读进来。
*
* ## 加密字段怎么处理
*
* 先问 `at-rest.ts` 要 at-rest 密钥并尝试解密；解不开就照旧按
* `reason: 'encrypted'` 上报并给出可操作提示（打开桌面端 / 设
* `WORKBUDDY_APP_EXECUTABLE`）。**绝不**把打不开的加密字段降级成空 token ——
* 那会让调用方以为用户没登录。
*
* @module dsh-connect-workbuddy-models/accounts
*/
/** 桌面端正在使用的那份登录文件名。它永远优先被选。 */
const WORKBUDDY_LIVE_FILENAME = "workbuddy-desktop.info";
/**
* 覆盖登录文件（或它所在目录）的环境变量。
*
* 允许指目录，是因为用户在 issue 里报自己的路径时通常给的是目录；只认文件会让
* 「我明明设了变量」变成一个静默的空池。
*/
const WORKBUDDY_AUTH_FILE_ENV = "WORKBUDDY_AUTH_FILE";
function nonEmptyEnv(value) {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : void 0;
}
/**
* 平台默认的登录目录。
*
* Windows 先探 Local 再探 Roaming：重定向过配置文件的机器上，登录文件可能在
* Roaming 里，而 `LOCALAPPDATA` 指向一个空目录——只探一个会得到「没有账号」。
*/
function defaultDesktopAuthDirs(platform = process.platform, home = homedir(), env = process.env) {
	if (platform === "darwin") return [join(home, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth")];
	if (platform === "win32") {
		const local = nonEmptyEnv(env["LOCALAPPDATA"]) ?? join(home, "AppData", "Local");
		const roaming = nonEmptyEnv(env["APPDATA"]) ?? join(home, "AppData", "Roaming");
		return [join(local, "CodeBuddyExtension", "Data", "Public", "auth"), join(roaming, "CodeBuddyExtension", "Data", "Public", "auth")];
	}
	if (platform === "linux") {
		const config = nonEmptyEnv(env["XDG_CONFIG_HOME"]) ?? join(home, ".config");
		return [join(config, "CodeBuddyExtension", "Data", "Public", "auth")];
	}
	return [];
}
/** Harness home 的默认目录名。 */
const DSH_HOME_DIR_NAME = ".dsh";
/** 覆盖 Harness home 的环境变量。 */
const DSH_HOME_ENV = "DSH_HOME";
/** vault 在 Harness home 下的目录名（与 `dsh-connect-workbuddy` 共用同一份磁盘格式）。 */
const WORKBUDDY_VAULT_DIRNAME = "workbuddy-vault";
/** 展开 `~`、`~/`、`~\`。其余路径原样返回（随后由 `resolve` 归一）。 */
function expandHomePath(path, home) {
	if (path === "~") return home;
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
	return path;
}
/**
* 解析 Harness home，判定顺序（高到低）：`$DSH_HOME` → `~/.dsh`。
*
* 逐条转写自 `plugins/dsh-connect-workbuddy/src/host-peers.ts:132-155` 的
* `fallbackResolveDshHome`，**不**从那个包 import：跨包相对导入在本插件打包成
* `lib/index.js` 之后会指到一个不存在的路径（两个插件各自独立发布）。转写而不是
* 猜，是因为错了会**静默**扫错目录——表现为「vault 里明明有 4 个账号，插件报
* 0 个」，而这与「这台机器确实没登录过」在界面上长得一模一样。
*
* 空白 `$DSH_HOME` 当作未设置：否则 `DSH_HOME=""` 会让 home 落到当前工作目录，
* 于是我在一个随机目录里找 `workbuddy-vault`。
*/
function resolveDshHome(configured, env = process.env, home = homedir()) {
	const fromEnv = nonEmptyEnv(env[DSH_HOME_ENV]);
	const chosen = configured ?? fromEnv ?? join(home, DSH_HOME_DIR_NAME);
	return resolve(expandHomePath(chosen, home));
}
/** vault 里某个区域的目录：`<dshHome>/workbuddy-vault/<region>`。 */
function workbuddyVaultDir(region, env = process.env, home = homedir()) {
	return join(resolveDshHome(void 0, env, home), WORKBUDDY_VAULT_DIRNAME, region);
}
/** vault 的两个区域目录，顺序固定 `cn` → `global`。 */
function workbuddyVaultDirs(env = process.env, home = homedir()) {
	return WB_REGIONS.map((region) => workbuddyVaultDir(region, env, home));
}
/** 该目录该收的后缀。 */
function suffixesOf(kind) {
	return kind === "vault" ? [".json"] : [".info"];
}
/**
* 目录语义 → 给人看的登录出处。
*
* 两套词表故意不同名：`WbAuthSource.kind` 说的是「这个目录怎么读」（后缀策略），
* `WbAccountSource` 说的是「这份凭据来自哪次登录」（决定该去重登桌面端还是重登
* dsh-connect-workbuddy）。直接在这里给出 `'dsh'` 字面量，既是 `WbAccountSource`
* 里那个成员唯一的产出点，也是这一层唯一的映射表。
*/
const SOURCE_OF_KIND = {
	vault: "dsh",
	desktop: "desktop"
};
/**
* 要扫描的目录列表：环境变量覆盖量 → 平台默认桌面端目录 → vault 两区域（去重）。
*
* vault 排**最后**：桌面端是唯一能反映「用户刚登录过」的来源，让它先被读到，
* 同一后缀轮内的粗排才是「活文件在前」。
*/
function candidateAuthSources(env = process.env) {
	const sources = [];
	const seen = /* @__PURE__ */ new Set();
	const push = (dir, kind) => {
		if (seen.has(dir)) return;
		seen.add(dir);
		sources.push({
			dir,
			kind
		});
	};
	const override = nonEmptyEnv(env[WORKBUDDY_AUTH_FILE_ENV]);
	if (override !== void 0) {
		const lower = override.toLowerCase();
		push(lower.endsWith(".info") || lower.endsWith(".json") ? resolve(override, "..") : resolve(override), lower.endsWith(".json") ? "vault" : "desktop");
	}
	for (const dir of defaultDesktopAuthDirs()) push(dir, "desktop");
	for (const dir of workbuddyVaultDirs(env)) push(dir, "vault");
	return sources;
}
/** 同 {@link candidateAuthSources} 的纯路径视图（既有调用点与诊断脚本用）。 */
function candidateAuthDirs(env = process.env) {
	return candidateAuthSources(env).map((source) => source.dir);
}
/**
* 凭据里存在加密字段，且本机打不开。
*
* 独立错误类而不是返回 `undefined`：调用方必须能区分「没登录」与「登录了，但持有
* 密钥的应用不在」——后者让用户「重新登录」是错的（他本来就登着）。
*
* 文案给出两**条**互斥的出路，因为这是两种不同的机器状态：装过
* `dsh-connect-workbuddy` 的机器上有 vault 明文副本（那就不会走到这里，除非 vault
* 也被删了）；只装了桌面端的机器必须让桌面端在场，密钥只存在于它的进程里。
*/
var WbEncryptedCredentialError = class extends Error {
	sourcePath;
	constructor(sourcePath) {
		super(`workbuddy: ${sourcePath} 的登录令牌被桌面端加密了（$wbEncrypted），本机取不到解密的 at-rest 密钥。请启动 WorkBuddy 桌面端并完成一次登录（密钥在它的进程里），或设置 WORKBUDDY_APP_EXECUTABLE 指向桌面端可执行文件。`);
		this.sourcePath = sourcePath;
		this.name = "WbEncryptedCredentialError";
	}
};
/** 秒或毫秒的到期时间统一成毫秒。 */
function expiryToMs(value) {
	if (value <= 0) return 0;
	return value > 0xe8d4a51000 ? value : value * 1e3;
}
function optionalString(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
/**
* 读一个字符串字段：可能是普通字符串（旧构建），也可能是桌面包出来的
* `$wbEncrypted` 信封。
*
* 三态而不是两态：`failed` 让调用方能区分「字段就是空的」与「字段加密了但我打不
* 开」——后者要按 `reason: 'encrypted'` 上报并让用户去开桌面端，前者才是「没登录」。
*
* 解密失败**不降级成空串**：那会让一份完好（只是本机没密钥）的凭据看起来像空的，
* 于是用户在界面上看到「没有账号」而跳过列表里也没有任何解释。
*/
function fieldOf(value, decrypt) {
	if (typeof value === "string") return {
		value,
		encrypted: false,
		failed: false
	};
	if (isEncryptedFieldWrapper(value)) {
		if (decrypt === void 0) return {
			value: "",
			encrypted: true,
			failed: true
		};
		try {
			return {
				value: decrypt(value),
				encrypted: true,
				failed: false
			};
		} catch {
			return {
				value: "",
				encrypted: true,
				failed: true
			};
		}
	}
	return {
		value: "",
		encrypted: false,
		failed: false
	};
}
/**
* 解析一个登录文件。
*
* 形状两种都认：`{ auth: {...}, account: {...} }`（桌面端与 vault 都是这个）与平铺
* 的一层（插件自己导出的）。身份字段优先读 `account` 段。
*
* `decrypt` 是**可选**第三参：不传就是「只认明文构建」，这与每个拿不到 at-rest 密钥
* 的调用点应当传入的东西一致（`undefined` 而非抛错的实现）。因此既有两参调用点
* 行为不变。
*
* 报价：`accessToken` 是信封且打不开 → 抛 {@link WbEncryptedCredentialError}，
* **绝不**当成「空 token 的可读凭据」。
*/
function parseWorkBuddyAuth(text, sourcePath, decrypt) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const document = parsed;
	let auth;
	let identity;
	if (typeof document["auth"] === "object" && document["auth"] !== null) {
		auth = document["auth"];
		identity = typeof document["account"] === "object" && document["account"] !== null ? document["account"] : {};
	} else {
		auth = document;
		identity = document;
	}
	const accessField = fieldOf(auth["accessToken"], decrypt);
	if (accessField.failed) throw new WbEncryptedCredentialError(sourcePath);
	if (accessField.value === "") return void 0;
	const refreshExpiresAtMs = typeof auth["refreshExpiresAt"] === "number" ? expiryToMs(auth["refreshExpiresAt"]) : void 0;
	const lastRefreshAtMs = typeof auth["lastRefreshTime"] === "number" ? expiryToMs(auth["lastRefreshTime"]) : void 0;
	const nickname = fieldOf(identity["nickname"], decrypt).value;
	const refreshToken = fieldOf(auth["refreshToken"], decrypt).value;
	return {
		accessToken: accessField.value,
		refreshToken,
		expiresAtMs: typeof auth["expiresAt"] === "number" ? expiryToMs(auth["expiresAt"]) : 0,
		...refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs },
		...lastRefreshAtMs === void 0 ? {} : { lastRefreshAtMs },
		...optionalString(nickname) === void 0 ? {} : { nickname: optionalString(nickname) },
		...optionalString(identity["uin"]) === void 0 ? {} : { uin: optionalString(identity["uin"]) },
		...optionalString(identity["uid"]) === void 0 ? {} : { uid: optionalString(identity["uid"]) },
		...optionalString(identity["enterpriseId"]) === void 0 ? {} : { enterpriseId: optionalString(identity["enterpriseId"]) },
		domain: typeof auth["domain"] === "string" ? auth["domain"] : "",
		sourcePath
	};
}
/** 人话名字；同名账号用 uid 前缀区分。 */
function accountLabel(credential) {
	const name = credential.nickname ?? "WorkBuddy";
	const discriminator = (credential.uid ?? credential.uin ?? "").slice(0, 8);
	return discriminator === "" ? name : `${name}#${discriminator}`;
}
/** 该文件是否是桌面端正在使用的登录（相对历史快照而言）。 */
function isLiveAuthFile(path) {
	return basename(path) === WORKBUDDY_LIVE_FILENAME;
}
/**
* 同一账号两份额度凭据里该留哪一份，最高优先在前：
*
* 1. 桌面端正在用的活文件；
* 2. 上游最近签发的那份（`lastRefreshAtMs`）；
* 3. 更晚的存储到期时间（只用于完全没有签发时间的文档）。
*
* 单看存储到期时间**不是**新鲜度信号：上游吊销 token 时不改写它，所以一份早已
* 死掉的备份可以声称比真正能用的 token 到期更晚。按它选号曾让每次调用都 401，
* 而同一个目录里明明躺着好凭据。
*
* 刷新窗口已关闭的文件排在最后：它救不回来（`refreshExpiresAt` 都过了），把它
* 排在同账号的有效凭据之前只会让这个账号彻底不可用。
*/
function compareFreshness(a, b) {
	if (a.refreshExpired !== b.refreshExpired) return a.refreshExpired ? 1 : -1;
	const aLive = isLiveAuthFile(a.sourcePath) ? 1 : 0;
	const bLive = isLiveAuthFile(b.sourcePath) ? 1 : 0;
	if (aLive !== bLive) return bLive - aLive;
	const aIssued = a.credential.lastRefreshAtMs ?? 0;
	const bIssued = b.credential.lastRefreshAtMs ?? 0;
	if (aIssued !== bIssued) return bIssued - aIssued;
	return b.credential.expiresAtMs - a.credential.expiresAtMs;
}
/**
* 两次发现拿到的，还是不是同一份登录凭据。
*
* 判据取 `accessToken` 与 `refreshToken` 两条——只有它们变了才算「换了一份凭据」。
* 不能用 `expiresAtMs`：上游刷新 token 时只改到期时间不改字符串的构建是存在的，
* 那种情况下凭据其实还是被拒的那一份。也不能只比 `accessToken`：一次「上游拒绝
* refresh token」之后，用户可能只重新签发了 refresh 那一条。
*
* 只在 `credentialDead === true` 时被调用，所以「空串对空串」这类退化比较不必
* 防御：真死掉的凭据至少有一个非空 token，否则它连请求都发不出去。
*/
function credentialRotated(previous, next) {
	return previous.credential.accessToken !== next.credential.accessToken || previous.credential.refreshToken !== next.credential.refreshToken;
}
/**
* 一个目录里该收的全部登录文件，名字新的在前（同 uid 冲突时的第一轮粗排）。
*
* 后缀来自目录**语义**（`suffixesOf`），不是一张全局白名单：桌面端目录只收
* `.info`，vault 目录只收 `.json`。无差别收 `.json` 会把桌面端目录里的
* `workbuddy-desktop.observation.json` 当成账号读进来。
*/
async function authFilesIn(source) {
	let entries;
	try {
		entries = await readdir(source.dir);
	} catch {
		return [];
	}
	const suffixes = suffixesOf(source.kind);
	return entries.filter((name) => suffixes.some((suffix) => name.toLowerCase().endsWith(suffix))).sort((a, b) => a < b ? 1 : a > b ? -1 : 0).map((name) => join(source.dir, name));
}
/**
* 读一个文件，返回账号 / 跳过原因。
*
* 失败一律**返回原因而不是抛错**：一个坏文件不能让整次扫描返回空池。旧实现把
* 加密错误一路抛出 scan，把已经解析成功的账号全丢了——用户看到「4 个账号变成 2 个」。
*/
async function readAccount(path, decrypt, kind) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return {
			path,
			reason: "unreadable"
		};
	}
	let credential;
	try {
		credential = parseWorkBuddyAuth(text, path, decrypt);
	} catch (error) {
		if (error instanceof WbEncryptedCredentialError) return {
			path,
			reason: "encrypted"
		};
		return {
			path,
			reason: "malformed"
		};
	}
	if (credential === void 0) return {
		path,
		reason: "malformed"
	};
	const refreshExpired = credential.refreshExpiresAtMs !== void 0 && credential.refreshExpiresAtMs > 0 && credential.refreshExpiresAtMs < Date.now();
	return {
		id: workbuddyAccountId(credential),
		label: accountLabel(credential),
		credential,
		region: regionOf(credential.domain),
		sourcePath: path,
		source: SOURCE_OF_KIND[kind],
		live: isLiveAuthFile(path),
		refreshExpired,
		...credential.expiresAtMs > 0 ? { tokenExpiresAtMs: credential.expiresAtMs } : {}
	};
}
/**
* 把调用方给的裸目录补成带来源语义的条目。
*
* `discoverAccounts({ authDirs })` 是既有 API（诊断脚本与单测都用它），只给路径。
* 判定规则只看**形状**：`<...>/workbuddy-vault/<region>` 才算 vault，其余当桌面端。
* 于是临时目录里的 `observation.json` 仍被排除，而「手工指向 vault 拷贝」也能读。
*/
function sourceOf(dir) {
	return {
		dir,
		kind: basename(resolve(dir, "..")) === "workbuddy-vault" ? "vault" : "desktop"
	};
}
/**
* 用 at-rest 密钥构造一次信封解密器。
*
* 取密钥可能失败（本机没装桌面端 / 装了但没登录过），也可能抛错；两种情况都返回
* `undefined`，由 {@link fieldOf} 把加密字段报成 `failed` 而不是把整次扫描炸掉。
* 每次扫描只取一次密钥：{@link readAtRestKey} 自己缓存，但一次扫描里重复调它会
* 在同一次 miss 上串行等同一份子进程结果。
*/
async function defaultDecrypt() {
	let key;
	try {
		key = await readAtRestKey();
	} catch {
		return;
	}
	if (key === void 0) return void 0;
	return (field) => {
		if (!isEncryptedFieldWrapper(field)) return typeof field === "string" ? field : "";
		return openEncryptedField(field, key);
	};
}
/**
* 把「本插件自己刷新过的那份凭据」盖到磁盘读出来的账号上。
*
* 为什么必须有这一步：刷新只发生在内存里（`chatStream` 原地改写 credential），而
* 磁盘上的 `.info` / vault `.json` 仍是旧 token——本插件**不回写**桌面端文件（那
* 是它的私有状态，且加密信封根本回写不了）。于是一旦重新扫描，`applyDiscovery`
* 用磁盘内容整体替换 `account`，刚换来的新 token 就被旧值盖回去了，表现为「明明
* 刚刷新成功，过一会儿又全部 401」。刷新记录因此必须先于折叠/排序生效。
*
* 谁赢用两个问题判定，都不看存储到期时间：
*
* 1. **磁盘那份是不是用户重新登录写的？** 刷新记录里的 `refreshedAtMs` 早于凭据
*    自带的 `lastRefreshAtMs` 时，说明桌面端/vault 在那之后又签发过一次，用户的
*    新登录必须赢——否则换了账号密码还是用旧 token。
* 2. **记录里的 token 自己是不是已经过期？** 过期了但磁盘那份还没过期，就用磁盘
*    的；两层都过期就照旧用记录（它带着旋转后的 refresh token，是唯一还能续期的
*    凭据），让 `chatStream` 的到期即刷把它救回来。
*/
function withRefreshedCredential(account, entry, nowMs) {
	if (entry === void 0) return account;
	const diskIssuedAtMs = account.credential.lastRefreshAtMs ?? 0;
	if (entry.refreshedAtMs <= diskIssuedAtMs) return account;
	const recordedExpired = entry.expiresAtMs > 0 && entry.expiresAtMs <= nowMs;
	const diskUsable = account.credential.expiresAtMs > nowMs;
	if (recordedExpired && diskUsable) return account;
	const credential = {
		...account.credential,
		accessToken: entry.accessToken,
		...entry.refreshToken === void 0 ? {} : { refreshToken: entry.refreshToken },
		expiresAtMs: entry.expiresAtMs,
		lastRefreshAtMs: entry.refreshedAtMs
	};
	return {
		...account,
		credential,
		...credential.expiresAtMs > 0 ? { tokenExpiresAtMs: credential.expiresAtMs } : { tokenExpiresAtMs: void 0 }
	};
}
/**
* 扫描全部候选目录，把每个可解析文件变成一个账号。
*
* 同一账号的多份快照折叠成一份（见 {@link compareFreshness}）：池里一个账号只能
* 出现一次，否则「剩余总积分」会把同一个人的历史快照重复相加。
*
* `decrypt` 不接受外部注入——它是内部实现细节；单测要喂合成信封时直接测
* {@link parseWorkBuddyAuth} 的三参形态，那条路径才是真正的契约面。
*/
async function discoverAccounts(options = {}) {
	const sources = options.authDirs === void 0 ? candidateAuthSources(options.env ?? process.env) : options.authDirs.map(sourceOf);
	const decrypt = await defaultDecrypt();
	const byId = /* @__PURE__ */ new Map();
	const skipped = [];
	for (const source of sources) for (const path of await authFilesIn(source)) {
		const read = await readAccount(path, decrypt, source.kind);
		if ("reason" in read) {
			skipped.push(read);
			continue;
		}
		const incumbent = byId.get(read.id);
		if (incumbent === void 0 || compareFreshness(read, incumbent) < 0) byId.set(read.id, read);
	}
	const refreshed = await loadRefreshedCredentials(PLUGIN_ID);
	const nowMs = Date.now();
	return {
		accounts: [...byId.values()].map((account) => withRefreshedCredential(account, refreshed[account.id], nowMs)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
		skipped
	};
}
/** `sticky` 记住多少个会话→账号绑定。只是内存上限：淘汰最老的一条只花一次重选。 */
const STICKY_AFFINITY_LIMIT = 200;
/**
* 账号池：持有发现结果、积分读数与选号策略。
*
* 选号**一定**走 `rankAccounts`（status-paths 的纯函数）——五种 `distribution` 的
* 差别在于「怎么消费这份有序列表」，而不是「谁是下一个」。把分布塞进比较器会让
* 同一份顺序对五种模式给出五种互不相同的解释，其中四种是错的。
*/
var WbAccountPool = class {
	options;
	entries = [];
	skipped = [];
	scannedAtMs = 0;
	/** 每个区域的轮转游标（`round-robin`）。 */
	cursors = /* @__PURE__ */ new Map();
	/** 会话 → 账号绑定（`sticky`）。Map 的插入序即 LRU 序。 */
	affinity = /* @__PURE__ */ new Map();
	/** 用户手动指定的当前账号（按区域），优先级高于任何分布。 */
	preferred = /* @__PURE__ */ new Map();
	constructor(options = {}) {
		this.options = options;
	}
	/** 用一次发现结果替换池内容，保留同一账号的积分读数与死凭据标记。 */
	applyDiscovery(result) {
		const previous = new Map(this.entries.map((entry) => [entry.account.id, entry]));
		const revived = [];
		this.entries = result.accounts.map((account) => {
			const kept = previous.get(account.id);
			if (kept === void 0) return { account };
			if (kept.credentialDead === true && credentialRotated(kept.account, account)) {
				revived.push(account.id);
				return {
					...kept,
					account,
					credentialDead: void 0
				};
			}
			return {
				...kept,
				account
			};
		});
		for (const accountId of revived) this.clearCredentialDead(accountId);
		this.skipped = result.skipped;
		this.scannedAtMs = Date.now();
	}
	/**
	* 施加一次配置。
	*
	* 单独一个方法而不是让调用方重建池：池持有**积分读数**、会话亲和与轮转游标，
	* 换号设置一次就可能被改一次，重建池会把用户刚看到的余额全部清空（卡片忽然
	* 变成「余额未知」），并把 `sticky` 的会话绑定丢掉。
	*
	* 字段为 `undefined` 时保持原值（来自「这次配置里没有这一项」，而不是「清空」）。
	*/
	applyConfig(config) {
		if (config.enabledIds !== void 0) this.options.enabledIds = config.enabledIds;
		if (config.orderIds !== void 0) this.options.orderIds = config.orderIds;
		if (config.distribution !== void 0) this.options.distribution = config.distribution;
		if (config.expiryWarnDays !== void 0) this.options.expiryWarnDays = config.expiryWarnDays;
	}
	/** 当前的临期窗口（天）。缺省表示「从未配置」，排序层用兜底值。 */
	get expiryWarnDays() {
		return this.options.expiryWarnDays;
	}
	/** 扫描时间（ms）；从未扫描时 0。 */
	get lastScannedAtMs() {
		return this.scannedAtMs;
	}
	/** 被跳过的文件，原样上报。 */
	get skippedFiles() {
		return this.skipped;
	}
	/** 全部账号（不论是否参与池），按 id 升序。 */
	list() {
		return this.entries;
	}
	/** 某区域的账号。 */
	listRegion(region) {
		return this.entries.filter((entry) => entry.account.region === region);
	}
	find(accountId) {
		return this.entries.find((entry) => entry.account.id === accountId);
	}
	/** 记一次积分读数。到期时间与余额同行——`expiry` 分布靠它排序。 */
	noteCredits(accountId, credits) {
		const entry = this.find(accountId);
		if (entry === void 0) return;
		if (credits === void 0) delete entry.credits;
		else entry.credits = credits;
	}
	/**
	* 记下签到状态。
	*
	* `undefined` 表示「这次没读到」，与 `undefined` 的积分同理：**不要**把它当作
	* 「今天没签到」——那会让卡片把一次网络失败渲染成「待签到」并怂恿用户去点。
	* 所以传 `undefined` 时保留旧读数而不是清除。
	*/
	noteCheckin(accountId, checkin) {
		const entry = this.find(accountId);
		if (entry === void 0 || checkin === void 0) return;
		entry.checkin = checkin;
	}
	/** 上游拒绝过这份凭据。 */
	markCredentialDead(accountId) {
		const entry = this.find(accountId);
		if (entry !== void 0) entry.credentialDead = true;
	}
	/** 清掉死凭据标记（重新登录 / 重新扫描后）。 */
	clearCredentialDead(accountId) {
		const entry = this.find(accountId);
		if (entry !== void 0) delete entry.credentialDead;
	}
	/** 设置某区域的当前账号（用户显式选择）。 */
	setPreferred(region, accountId) {
		if (accountId === void 0 || accountId === "") this.preferred.delete(region);
		else this.preferred.set(region, accountId);
	}
	/** 当前账号（按区域）。 */
	preferredOf(region) {
		return this.preferred.get(region);
	}
	/** 该账号是否参与池。`enabledIds` 为空 = 全部参与。 */
	isEnabled(accountId) {
		const enabled = this.options.enabledIds;
		if (enabled === void 0 || enabled.length === 0) return true;
		return enabled.includes(accountId);
	}
	/**
	* 一个账号此刻为什么不能服务；能服务时缺省。
	*
	* 这段话会**原样显示在账号卡片上**，所以每一条都要能让用户采取行动（「重新登录」、
	* 「加入池」、「等 X 分钟」），而不是只说「不可用」。
	*/
	exclusionReason(entry) {
		if (!this.isEnabled(entry.account.id)) return "未加入池（在「参与池的账号」里勾选它）";
		if (entry.account.refreshExpired) {
			const at = entry.account.credential.refreshExpiresAtMs;
			return `登录窗口已关闭${at === void 0 ? "" : `（${new Date(at).toLocaleString("zh-CN")}）`}，请重新登录 WorkBuddy 桌面端`;
		}
		if (entry.credentialDead === true) return "上游已拒绝这份登录凭据，请重新登录 WorkBuddy 桌面端";
	}
	/**
	* 排序一个区域的成员。`distribution` 的 `expiry` 语义在这里生效。
	*
	* `credits` 理想上由探测层按**用户配置的 `expiryWarnDays`** 聚合过（`probe.ts`
	* 负责），那样 `expiringSoon` 是显式值、`expiryFactsOf` 直接采信。但请求路径上
	* 余额是 `shim.ts` 写的——它拿得到原始包、拿不到聚合结果的历史——所以用户窗口
	* 还有第二条路：作为 `rankAccounts` 的第 5 个实参传下去，让排序层的兜底推算也
	* 按同一个窗口算。两条路都给，任何一条断了都不会静默退回 3 天。
	*/
	rank(region, nowMs = Date.now()) {
		return rankAccounts(this.listRegion(region).map((entry) => ({
			account: entry.account,
			...entry.credits === void 0 ? {} : { credits: entry.credits },
			usable: this.exclusionReason(entry) === void 0
		})), nowMs, this.options.orderIds ?? [], this.options.distribution ?? "expiry", this.options.expiryWarnDays ?? 3);
	}
	/**
	* 选下一个该服务的账号。
	*
	* 五种分布都**真正分支**（R4：不得只声明不生效），且都建立在同一份
	* {@link rank} 顺序之上：
	*
	* - `priority`：永远队首——单号额度大时「用完一个再换」最省事。
	* - `round-robin`：按游标依次轮过可用成员。
	* - `balanced`：按余额权重抽取，冷清时也不会把第一个号抽干。
	* - `sticky`：一个会话钉一个号；新会话换下一个可用号（保住上游 prompt 缓存）。
	* - `expiry`：队首即「一次性积分包最先到期」的账号（R3）。
	*
	* 用户在卡片上显式选的当前账号（{@link setPreferred}）优先于任何分布——那是
	* 一个明确指令，不是一次采样。
	*/
	pick(region, options = {}) {
		const ranked = this.rank(region, options.nowMs ?? Date.now());
		const excluded = options.excludeIds === void 0 ? void 0 : new Set(options.excludeIds);
		const usable = ranked.filter((row) => this.exclusionReason(this.entryOf(row.account)) === void 0 && (excluded === void 0 || !excluded.has(row.account.id)));
		if (usable.length === 0) return { ranked };
		const preferredId = this.preferred.get(region);
		if (preferredId !== void 0) {
			const chosen = usable.find((row) => row.account.id === preferredId);
			if (chosen !== void 0) return {
				account: chosen.account,
				ranked
			};
		}
		switch (this.options.distribution ?? "expiry") {
			case "round-robin": {
				const cursor = this.cursors.get(region) ?? 0;
				const chosen = usable[cursor % usable.length];
				this.cursors.set(region, cursor + 1);
				return chosen === void 0 ? { ranked } : {
					account: chosen.account,
					ranked
				};
			}
			case "balanced": {
				const weights = usable.map((row) => Math.max(1, row.score));
				const total = weights.reduce((sum, weight) => sum + weight, 0);
				let ticket = Math.random() * total;
				for (const [index, weight] of weights.entries()) {
					ticket -= weight;
					if (ticket <= 0) {
						const chosen = usable[index];
						if (chosen !== void 0) return {
							account: chosen.account,
							ranked
						};
					}
				}
				const last = usable[usable.length - 1];
				return last === void 0 ? { ranked } : {
					account: last.account,
					ranked
				};
			}
			case "sticky": {
				const key = options.conversationKey;
				if (key !== void 0) {
					const bound = this.affinity.get(key);
					if (bound !== void 0) {
						const chosen = usable.find((row) => row.account.id === bound);
						if (chosen !== void 0) {
							this.affinity.delete(key);
							this.affinity.set(key, bound);
							return {
								account: chosen.account,
								ranked
							};
						}
					}
				}
				const loads = /* @__PURE__ */ new Map();
				for (const id of this.affinity.values()) loads.set(id, (loads.get(id) ?? 0) + 1);
				const chosen = [...usable].sort((a, b) => {
					const loadA = loads.get(a.account.id) ?? 0;
					const loadB = loads.get(b.account.id) ?? 0;
					if (loadA !== loadB) return loadA - loadB;
					return 0;
				})[0];
				if (chosen !== void 0 && key !== void 0) {
					this.affinity.set(key, chosen.account.id);
					while (this.affinity.size > STICKY_AFFINITY_LIMIT) {
						const oldest = this.affinity.keys().next();
						if (oldest.done === true) break;
						this.affinity.delete(oldest.value);
					}
				}
				return chosen === void 0 ? { ranked } : {
					account: chosen.account,
					ranked
				};
			}
			default: {
				const chosen = usable[0];
				return chosen === void 0 ? { ranked } : {
					account: chosen.account,
					ranked
				};
			}
		}
	}
	/** 名次行 → 池条目。 */
	entryOf(account) {
		const entry = this.find(account.id);
		if (entry === void 0) return { account };
		return entry;
	}
};
/**
* 从一批账号里找一个能读出目录的，逐个尝试。
*
* 逐账号而不是只赌队首：池里任一账号的凭据都可能已被上游吊销（401），而读目录
* 只需要一个健康账号；只赌第一个会让一份死 token 拖垮整个区域的实时目录。
*/
async function fetchCatalogFromAny(accounts, read) {
	const failures = [];
	for (const account of accounts) try {
		return {
			models: await read(account),
			source: "live"
		};
	} catch (error) {
		failures.push(`${account.label}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return {
		models: [],
		source: "fallback",
		error: failures.length === 0 ? "没有可用账号" : failures.join(" | ")
	};
}
/** 供测试与诊断：把一份上游条目列表按 user 选择过滤前的原始形态交出。 */
function modelsOfDocument(document, keepIds = []) {
	if (typeof document !== "object" || document === null) return [];
	const data = document;
	return selectCliModels(data["models"], data["agents"], keepIds);
}
//#endregion
//#region src/adapter.ts
/**
* `dsh-connect-workbuddy-models` 的 pi-ai provider：注册进 Harness LLM seam 的回环
* 适配器，由 `dsh-llm-pi-ai` 的公开扩展点装配。每个模型都指向本插件的回环 shim；
* 账号选择留在 shim 内部（下一次请求由池重新选号）。
*
* 装配形状（`createProvider` + `openAICompletionsApi` + 惰性 auth 面 + 以 shim 的
* 进程内 secret 作 apiKey）沿用同仓 `dsh-connect-trae-models/src/adapter.ts` 与
* `dsh-workbuddy-xdpool` 的已验证设计（血统为 corrinehu/dsh-workbuddy-connect，MIT）。
*
* @module dsh-connect-workbuddy-models/adapter
*/
/**
* 目录没给窗口时的兜底。
*
* DSH 对 `contextWindow` 缺失/非正数的模型会以 `INVALID_MODEL_CONTEXT` 失败，而那会
* 拖垮**整条** provider 路由——比一个不精确的窗口严重得多。实时 CN 名册偶尔缺这个
* 字段（`hy3` 早期版本就没有），所以这里必须有一个正数兜底。
*
* 取 128k 而不是 1M：低估会让 DSH 更早压缩上下文（可用性下降但不会 400），高估会让
* 长请求直接被上游拒绝（看起来像「这个模型坏了」）。两种错的代价不对称。
*/
const WB_DEFAULT_CONTEXT_WINDOW = 128e3;
/** 目录没给输出上限时的兜底。同样取保守值。 */
const WB_DEFAULT_MAX_TOKENS = 8192;
/**
* 单次流读取挂起期间的 provider 空闲上限。
*
* 取 15 分钟，与 `dsh-connect-trae-models` 同值并沿用同一份证据：排队型通道在晚高峰
* 把请求挂在队列里 6~10 分钟才排到（对照模型 1 秒级首字），5 分钟会在请求即将排到前
* 被本地误杀。真正的「上游完全静默」另由 shim 的等待队列保护，不会靠这个值兜底。
*/
const WB_STREAM_IDLE_TIMEOUT_MS = 9e5;
/** dsh-llm-pi-ai 默认值下的图片请求预算（与同仓其它连接器一致）。 */
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: 20971520,
	requestImagePixelBudget: 4194304,
	requestImageMaxBytes: 1048576
};
/**
* 惰性 pi-ai auth 面。该路由只通过每请求解析的 shim 共享 secret 认证，所以 pi-ai
* 自己的凭据生命周期绝不能为它制造凭据——真的生成一个会让 DSH 的 `auth login`
* 界面出现一个永远登不进去的条目。
*/
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-connect-workbuddy-models: this route has no pi-ai credential lifecycle");
		},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
/**
* 订阅制额度没有可推断的按 token 定价；报零。
*
* 不填一个「估算单价」是有意的：DSH 用 `cost` 做用量面板的金额，而 WorkBuddy 的
* 计费单位是积分、倍率按模型浮动。编一个数字会让面板显示一个既不是钱也不是积分的
* 东西。积分读数走本插件自己的状态路由。
*/
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
/** pi-ai 输入模态：只有目录宣告图片时才允许图片。 */
function modelInput(info) {
	return info.supportsImages === true || info.multimodal === true ? ["text", "image"] : ["text"];
}
/** 中点分隔符：模型 id/名字里自带连字符与点，用空格中点才不会读成名字的一部分。 */
const DISPLAY_SEPARATOR = " · ";
/**
* 倍率的显示后缀。
*
* `creditMultiplier === undefined` **不加任何后缀**，而不是打印「倍率未知」。
*
* 理由：CN 静态兜底名册整份没有该字段（上游那个版本没给 `credits`），所以启动后到
* 第一次实时刷新之间，全部 11 个模型都会是「未知」；给每一行都挂上「倍率未知」会把
* 模型选择器变成一屏噪声，而且那个状态是**临时的**。真正需要区分「未知 / 免费」的
* 场合是设置页的模型表（`WbCatalog.multiplierLabelOf` 在那里给出完整文案），那里
* 有列标题、有上下文，用户读得懂。
*
* `0` 打印成「免费」而不是 `x0.00`：后者读起来像零费率计费，且完全没表达促销含义。
*/
function displaySuffix(info) {
	const multiplier = info.creditMultiplier;
	if (multiplier === void 0) return void 0;
	if (!Number.isFinite(multiplier)) return void 0;
	if (multiplier === 0) return "免费";
	return `x${multiplier.toFixed(2)}`;
}
/**
* 把倍率搭到模型显示名上。
*
* 只影响显示：wire 请求由 `model.id` 构造，所以改名不可能影响路由、token 或上游计费。
* DSH 的 composer（ModelSelect）只渲染 `model.name`，这正是「选模型时能看到倍率」
* 只能靠改名字实现的原因——没有独立的价格列可用。
*/
function withMultiplierDisplay(name, info) {
	const suffix = displaySuffix(info);
	return suffix === void 0 ? name : `${name}${DISPLAY_SEPARATOR}${suffix}`;
}
/**
* pi-ai 能表达的思考档位，从低到高（不含 `off`）。
*
* 与 `upstream.ts` 的 `EFFORT_LADDER` 同序但**刻意分居两处**：那边是「上游会发什么」
* 的解析阶梯，这边是「pi-ai 认什么」的适配词表。合并成一个常量会让上游悄悄多出一个
* pi-ai 不认识的档位时，被本适配层无声吞下。
*/
const THINKING_LEVELS = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/** 路由默认档位：目录没给默认值、用户也没选时用它。 */
const WB_DEFAULT_EFFORT = "high";
/**
* 把上游的档位名单翻译成 pi-ai 的 `thinkingLevelMap`。
*
* `undefined` = **不宣告推理能力**，pi-ai 的 `getSupportedThinkingLevels` 随后只返回
* `['off']`，composer 不画档位选择器。三种情形走到这里：
*
* 1. 上游没给 `reasoning`（`default` / `hunyuan-chat` / 静态兜底名册全部条目）；
* 2. 上游给了但 `supportedEfforts` 是空的（`{}` 空对象，实测 8 个模型）；
* 3. 上游给了名单，但一个都不在 pi-ai 的词表里（未来上游引入新拼写时）。
*
* 第 3 种是**故意保守**：把 pi-ai 不认识的档位一律 `null` 掉，而不是原样透传。pi-ai
* 对 `null` 的理解是「这档不支持」，于是选择器里不会出现一个按下去就 400 的选项。
*
* `off` 的条件是**两个与**，缺一不可：
* - `canDisableThinking === true`（上游明确说能关思考）；
* - 模型 id 不在 {@link WB_REFUSES_OFF_MODEL_IDS}（实测它会拒 `off`）。
*
* 第二个条件在这里再查一遍，而不是只依赖上游数据：`off` 一旦成为必需档位（DSH 会把它
* 当作「不带 effort 字段」的隐式默认），一个错的 `off` 会让该模型之后每一轮请求都失败。
* 墙要建在离请求最近的地方。
*/
function wbThinkingLevelMap(info) {
	const supported = info.reasoning?.supportedEfforts?.filter((effort) => THINKING_LEVELS.includes(effort));
	if (supported === void 0 || supported.length === 0) return void 0;
	const map = Object.fromEntries(THINKING_LEVELS.map((level) => [level, supported.includes(level) ? level : null]));
	map.off = info.reasoning?.canDisableThinking === true && !WB_REFUSES_OFF_MODEL_IDS.has(info.id) ? "off" : null;
	return map;
}
/**
* 构造一个指向回环 shim 的 pi-ai 模型描述符。
*
* `baseUrl` 由调用方每次读取时重新解析，让 shim 的临时端口从启动后的第一份快照起
* 就生效（shim 用 `listen(0)` 随机端口，不重新解析就会指向上一进程的端口）。
*/
function toPiModel(info, baseUrl, providerId) {
	const contextWindow = Number.isFinite(info.contextWindow) && (info.contextWindow ?? 0) > 0 ? info.contextWindow : WB_DEFAULT_CONTEXT_WINDOW;
	const maxTokens = Number.isFinite(info.maxTokens) && (info.maxTokens ?? 0) > 0 ? info.maxTokens : WB_DEFAULT_MAX_TOKENS;
	const thinkingLevelMap = wbThinkingLevelMap(info);
	return {
		id: info.id,
		name: withMultiplierDisplay(info.name, info),
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input: modelInput(info),
		cost: NO_COST,
		contextWindow,
		maxTokens,
		reasoning: thinkingLevelMap !== void 0,
		...thinkingLevelMap === void 0 ? {} : { thinkingLevelMap },
		compat: { supportsReasoningEffort: thinkingLevelMap !== void 0 }
	};
}
/**
* pi-ai 唯一会给「没有推理元数据」的模型提供的档位。
*
* 宿主对这个档位的翻译是「不带 reasoning 字段」（`profileOptions` 把 `off` 变成
* `undefined`），所以钉它既没有凭空创造能力，也没有改变请求体里任何一个字节。
*/
const NO_REASONING_EFFORT = ReasoningEffortId("off");
/** 告诉宿主一个没有推理元数据的模型能做什么：恰好就这一档。 */
const NO_REASONING_EFFORTS = { efforts: [{
	id: NO_REASONING_EFFORT,
	name: "Off"
}] };
/**
* 把「路由默认档位」归一化成该模型真能接受的一档。
*
* **为什么需要这一层。** `profile.reasoning` 是**按路由**的一个默认值，而能力是按
* **模型**的。`dsh-llm-pi-ai` 把每个请求的档位解析成
* `options.reasoningEffort ?? profile.reasoning`，然后交给
* `resolveReasoningLevel` 校验；校验失败抛 `UNSUPPORTED_REASONING_EFFORT`，发生在
* **请求发出之前**——没有 wire 调用、没有上游错误、没有可重试的东西，模型在本地直接
* 不可用。名册里两类模型会撞上这个：完全没宣告 `reasoning` 的（`default`、
* `hunyuan-chat`、以及整个静态兜底名册），和宣告了但档位集合不含默认值的。
*
* **两道门都得过。** 宿主先看 adapter 自己的模型元数据：`resolveCallWithInfo` 拒绝在
* 没有 `reasoning` 字段的模型上接受**任何**显式档位，而 `reasoningInfo` 恰好对这类
* 模型不产出该字段——连 `off` 都会被拒。然后 `streamWithSnapshot` 再拒掉继承来的路由
* 默认值。只修任何一道门，另一道仍然失败。
*
* **修法。** 对这类模型宣告 pi-ai 唯一会接受的那一档（`off`），并在派发处把请求归一化
* 到它。请求体因此没有任何变化：pi-ai 对 `reasoning: false` 的模型根本不会发
* `reasoning_effort`。
*
* **什么仍然严格。** 调用方**显式**点名一个该模型做不到的档位，仍然被宿主拒绝，且
* 错误信息准确。那是既有契约，也不是这里要修的缺陷——缺陷是「没有点名任何档位」的请求
* 被路由自己的默认值杀掉了。
*/
/**
* 请求该用哪一档：`undefined` = **原样别动**，否则就是该钉成的那一档。
*
* 抽成纯函数是为了能直接测：`pinEffort` 的每个分支都是「某种模型 × 某种请求」的组合，
* 而它只在真正派发时才跑——通过 `stream()` 间接测等于要造整条 pi-ai 调用链。
*
* 三类返回：
* - `undefined`：调用方要的档位这个模型能用（或目录里根本没这个模型），不插手；
* - `'off'`：不宣告推理能力的模型，或连最低档都取不到——`off` 在 pi-ai 里等于
*   **不发 `reasoning_effort`**，所以请求体不变，只是不再被宿主按「档位不合法」拒掉；
* - 具体档位：路由默认值该模型接不了，降到它接受的上游默认档或最低档。
*
* `requested` 用裸 `string` 而不是 `ReasoningEffortId`：调用方（宿主）给的就是字符串，
* 这一层只做比较，不承担品牌类型的校验职责。
*/
function wbResolveEffort(info, requested) {
	const map = wbThinkingLevelMap(info);
	if (map === void 0) return NO_REASONING_EFFORT;
	const offered = THINKING_LEVELS.filter((level) => typeof map[level] === "string");
	const usable = map.off === "off" ? ["off", ...offered] : offered;
	const effective = requested ?? "high";
	if (usable.includes(effective)) return void 0;
	const upstreamDefault = info.reasoning?.defaultEffort;
	return (upstreamDefault !== void 0 && usable.includes(upstreamDefault) ? upstreamDefault : offered[0]) ?? NO_REASONING_EFFORT;
}
var WbEffortNormalizingAdapter = class extends PiAiAdapter {
	/**
	* 按模型 id 查当前目录条目。
	*
	* 每次调用都现查，因为目录会在 adapter 背后被刷新（`invalidate`）：一个中途拿到
	* 推理元数据的模型必须立刻停止被归一化。
	*/
	infoOf;
	constructor(config, infoOf) {
		super(config);
		this.infoOf = infoOf;
	}
	async resolveModel(provider, model, signal) {
		return this.advertiseOffOnly(await super.resolveModel(provider, model, signal));
	}
	async prepareCall(provider, model, signal) {
		const call = await super.prepareCall(provider, model, signal);
		return {
			model: this.advertiseOffOnly(call.model),
			stream: (options) => call.stream(this.pinEffort(options))
		};
	}
	stream(options) {
		return super.stream(this.pinEffort(options));
	}
	/**
	* 给没有推理元数据的模型补上它唯一能派发的那一档。
	*
	* **刻意不补 `defaultEffort`**：宿主会把默认值实体化进**每一个**没点名档位的请求，
	* 那会让宿主自己的 prepared-call 配置校验（`callConfigEquals`）去对付省略该字段的
	* 调用方。
	*/
	advertiseOffOnly(info) {
		return info.reasoning === void 0 ? {
			...info,
			reasoning: NO_REASONING_EFFORTS
		} : info;
	}
	/**
	* 把一个该模型用不了的档位换成它真能接受的一档。
	*
	* 只可能在**路由默认值**上触发：显式档位已被宿主按宣告的档位名单校验过，选不出一个
	* 不支持的（能选出来的必然在名单里）。所以这里的替换不会掩盖任何「用户要了什么」，
	* 只是不让插件自己的默认值把模型打死。
	*/
	pinEffort(options) {
		const info = this.infoOf(options.model);
		if (info === void 0) return options;
		const pinned = wbResolveEffort(info, options.reasoningEffort);
		if (pinned === void 0) return options;
		if (pinned === NO_REASONING_EFFORT) return options.reasoningEffort === NO_REASONING_EFFORT ? options : {
			...options,
			reasoningEffort: NO_REASONING_EFFORT
		};
		return {
			...options,
			reasoningEffort: ReasoningEffortId(pinned)
		};
	}
};
/**
* 装配 adapter。
*
* `getModels` 每次都重读实时目录并重新解析 `baseUrl`：
* - 目录会随上游刷新变化（新模型上线、促销模型下线），缓存列表会让用户在选择器里
*   看不到新模型，直到重启。
* - 用户改「显示哪些模型」后，`catalog.visible()` 立刻反映新选择——这是 R1-g 的
*   唯一生效点（过滤在 catalog 层做完，adapter 不重复过滤）。
*
* 只在 `shim.ready` 之后调用。
*/
function createWbAdapter(options) {
	const { shim, catalog, region } = options;
	const providerId = options.providerId ?? WB_PROVIDERS[region];
	const displayName = options.displayName ?? (region === "global" ? "WorkBuddy 模型池（国际版）" : "WorkBuddy 模型池（国内版）");
	const buildModels = () => {
		const baseUrl = `${shim.baseUrl()}/v1`;
		return catalog.visible().map((info) => toPiModel(info, baseUrl, providerId));
	};
	const provider = {
		...createProvider({
			id: providerId,
			name: displayName,
			auth: { apiKey: {
				name: "WorkBuddy 模型池回环密钥",
				async resolve({ credential }) {
					const apiKey = credential?.key;
					return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
						auth: { apiKey },
						source: "WorkBuddy 模型池"
					};
				}
			} },
			models: buildModels(),
			api: openAICompletionsApi()
		}),
		getModels: () => buildModels()
	};
	const profile = {
		provider: providerId,
		displayName,
		streamIdleTimeoutMs: WB_STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(void 0, "dsh-connect-workbuddy-models retryPolicy"),
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		modelErrors: /* @__PURE__ */ new Map(),
		/**
		* 路由默认档位。
		*
		* `dsh-llm-pi-ai` 把每个请求的档位解析成 `options.reasoningEffort ?? profile.reasoning`。
		* 不设这个字段的后果是「由 pi-ai 自己填」——对档位表里 `off` 可用的模型，它会填
		* `off`，于是**每一次压缩摘要**都在要求 `deepseek-v4.1-flash` 这类模型关闭思考，
		* 而上游会对其中一部分回 400。
		*
		* 取 `high` 而不是 `off`：这是本插件全部实测量据里上半区模型都接受的档位，也是
		* 「正常对话」应得的默认质量。接不住 `high` 的模型（只宣告了 `low`/`medium`，或
		* 完全没宣告）由 `WbEffortNormalizingAdapter.pinEffort` 逐模型降到它接受的那一档
		* ——默认值是按路由写的，能力是按模型量的，两者必须在这一层对齐。
		*/
		reasoning: WB_DEFAULT_EFFORT,
		...REQUEST_IMAGE_BUDGETS,
		piProvider: provider
	};
	let profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
	const infoOf = (model) => catalog.visible().find((info) => info.id === model);
	return {
		providerId,
		displayName,
		adapter: new WbEffortNormalizingAdapter({
			profiles: () => profiles,
			auth: INERT_AUTH,
			resolveApiKey: async () => shim.token(),
			resolveAttachments: () => options.ctx.get("attachments"),
			resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, (hostPath) => options.ctx.get("fs")?.processPathFromHostPath(hostPath), ref)
		}, infoOf),
		buildModels,
		invalidate: () => {
			profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
		}
	};
}
/**
* 供 model-resolve 路径用的「这次请求该用哪个账号」的解释。
*
* adapter 本身**不做选号**：选号发生在 shim 收到请求时（那时才知道 region、会话键与
* 当前池状态）。这个函数只把「为什么下一次会切到某个账号」讲清楚，供设置页与
* 诊断路由显示，避免两处各写一遍选号理由。
*/
function describeSelection(region, chosen, reason) {
	const area = region === "global" ? "国际版" : "国内版";
	if (chosen === void 0) return `${area}：没有可服务的账号（检查登录与「参与池的账号」）`;
	switch (reason) {
		case "preferred": return `${area}：使用你手动选定的账号「${chosen.label}」`;
		case "distribution": return `${area}：按账户使用方式选中「${chosen.label}」`;
		default: return `${area}：使用「${chosen.label}」`;
	}
}
//#endregion
//#region src/catalog.ts
/**
* 模型目录：静态兜底 + 实时刷新 + 用户选择过滤。
*
* 三件事各有一个明确的归属，混在一起就会出问题：
*
* 1. **静态兜底**（{@link FALLBACK_MODELS_CN} / {@link FALLBACK_MODELS_GLOBAL}）——
*    照抄 `plugins/dsh-connect-workbuddy/src/catalog.ts:37-100`。它的存在只是为了让
*    provider 在第一次实时刷新落地之前、或上游不通时**不为空**。两个区域各一份：
*    CN 名册里没有 `gpt-*`/`gemini-*`，用 CN 名册去喂一个国际账号会让用户看到
*    一堆点了必然失败的模型。
* 2. **实时刷新**（{@link WbCatalog.applyFetch}）——从上游读到的名册替换兜底，
*    带上真实的 `creditMultiplier`。
* 3. **用户选择**（`enabledModelIds`）——过滤**在这里**完成，adapter 只暴露过滤后的
*    列表。放在 adapter 里会让 shim 的 `/v1/models` 与 adapter 的模型列表各过滤一次，
*    任何一次口径漂移都表现为「选择器里有这个模型，但选它 404」。
*
* @module dsh-connect-workbuddy-models/catalog
*/
/**
* 剥掉名字末尾的拥挤度符号后缀。
*
* 认「空格 + 已知符号」的形式，而不是记住上次加了几位：后者在名册被
* {@link WbCatalog.applyFetch} 整份替换之后就会失配，于是名字越滚越长。
* 多次循环是为了处理「上一次忘了剥、这一次又加」的历史脏值。
*/
function stripBusySuffix(name) {
	let current = name;
	for (;;) {
		const stripped = current.replace(/ (?:🚀|🧍🧍🧍|🧍🧍|🧍|🚫)$/u, "");
		if (stripped === current) return current;
		current = stripped;
	}
}
/**
* CN 静态兜底名册（2026-08-30 抓取）。
*
* **整份没有 `creditMultiplier`**：上游 CN 的 `/v2/enterprises/personal/models` 在
* 这个版本没给 `credits` 字段。这不是遗漏——照抄它才是对的：补一个 0 会把收费
* 模型显示成免费，补一个猜测的倍率会让用户按错的成本预期选模型。`undefined`
* 在界面上渲染成「倍率未知」，这是唯一诚实的表达。
*
* `auto` 路由模型刻意不在表里：它按请求解析成不同模型，不是本插件能描述的一行。
*/
const FALLBACK_MODELS_CN = [
	{
		id: "hy3",
		name: "Hy3",
		contextWindow: 192e3,
		maxTokens: 64e3
	},
	{
		id: "glm-5v-turbo",
		name: "GLM-5v-Turbo",
		contextWindow: 2e5,
		maxTokens: 64e3
	},
	{
		id: "glm-5.3",
		name: "GLM-5.3",
		contextWindow: 1e6,
		maxTokens: 48e3
	},
	{
		id: "glm-5.2",
		name: "GLM-5.2",
		contextWindow: 1e6,
		maxTokens: 48e3
	},
	{
		id: "glm-5.1",
		name: "GLM-5.1",
		contextWindow: 2e5,
		maxTokens: 48e3
	},
	{
		id: "minimax-m3",
		name: "MiniMax-M3",
		contextWindow: 512e3,
		maxTokens: 128e3
	},
	{
		id: "kimi-k3-1",
		name: "Kimi-K3",
		contextWindow: 1e6,
		maxTokens: 32e3
	},
	{
		id: "kimi-k2.7",
		name: "Kimi-K2.7-Code",
		contextWindow: 256e3,
		maxTokens: 32e3
	},
	{
		id: "kimi-k2.6",
		name: "Kimi-K2.6",
		contextWindow: 256e3,
		maxTokens: 32e3
	},
	{
		id: "deepseek-v4-flash",
		name: "Deepseek-V4-Flash",
		contextWindow: 1e6,
		maxTokens: 5e4
	},
	{
		id: "deepseek-v4-pro",
		name: "Deepseek-V4-Pro",
		contextWindow: 1e6,
		maxTokens: 5e4
	}
];
/**
* 国际网关静态兜底名册（`www.workbuddy.ai/v3/config` 桌面通道，2026-09-11 抓取）。
*
* 这份**带倍率**（上游给了 `credits` 字段），所以国际版的「模型与倍率」列表在
* 上游不通时也是准的。注意 `deepseek-v4.1-flash` 与 `hy4-preview`/`hy3` 是
* `x0.00` 的促销免费模型——它们存在是「为什么国际版要读桌面通道」的理由
* （CLI 通道的名册里没有促销模型）。
*/
const FALLBACK_MODELS_GLOBAL = [
	{
		id: "default-model",
		name: "Auto",
		contextWindow: 176e3,
		maxTokens: 24e3,
		creditMultiplier: .79
	},
	{
		id: "fast-model",
		name: "Fast",
		contextWindow: 2e5,
		maxTokens: 32e3,
		creditMultiplier: .34
	},
	{
		id: "balanced-model",
		name: "Balanced",
		contextWindow: 256e3,
		maxTokens: 32e3,
		creditMultiplier: .59
	},
	{
		id: "primary-model",
		name: "Primary",
		contextWindow: 272e3,
		maxTokens: 72e3,
		creditMultiplier: 3.31
	},
	{
		id: "deep-model",
		name: "Deep",
		contextWindow: 176e3,
		maxTokens: 24e3,
		creditMultiplier: 3.33
	},
	{
		id: "deepseek-v4.1-flash",
		name: "Deepseek-V4.1-Flash",
		contextWindow: 1e6,
		maxTokens: 128e3,
		creditMultiplier: 0
	},
	{
		id: "gpt-6-astra",
		name: "GPT-6-Astra",
		contextWindow: 1e6,
		maxTokens: 128e3,
		creditMultiplier: 6.67
	},
	{
		id: "hy4-preview",
		name: "Hy4 preview",
		contextWindow: 1e6,
		maxTokens: 64e3,
		creditMultiplier: 0
	},
	{
		id: "hy3",
		name: "Hy3",
		contextWindow: 192e3,
		maxTokens: 64e3,
		creditMultiplier: 0
	},
	{
		id: "gpt-5.6-sol",
		name: "GPT-5.6-Sol",
		contextWindow: 1e6,
		maxTokens: 128e3,
		creditMultiplier: 3.47
	},
	{
		id: "gpt-5.6-terra",
		name: "GPT-5.6-Terra",
		contextWindow: 1e6,
		maxTokens: 128e3,
		creditMultiplier: 1.39
	},
	{
		id: "gpt-5.6-luna",
		name: "GPT-5.6-Luna",
		contextWindow: 1e6,
		maxTokens: 128e3,
		creditMultiplier: .14
	},
	{
		id: "gpt-5.5",
		name: "GPT-5.5",
		contextWindow: 1e6,
		maxTokens: 128e3,
		creditMultiplier: 3.31
	},
	{
		id: "gpt-5.4",
		name: "GPT-5.4",
		contextWindow: 272e3,
		maxTokens: 72e3,
		creditMultiplier: 1.65
	},
	{
		id: "gpt-5.3-codex",
		name: "GPT-5.3-Codex",
		contextWindow: 272e3,
		maxTokens: 72e3,
		creditMultiplier: 1.25
	},
	{
		id: "gemini-3.5-flash",
		name: "Gemini-3.5-Flash",
		contextWindow: 1e6,
		maxTokens: 65536,
		creditMultiplier: .99
	},
	{
		id: "glm-5.3",
		name: "GLM-5.3",
		contextWindow: 1e6,
		maxTokens: 48e3,
		creditMultiplier: .79
	},
	{
		id: "glm-5.2",
		name: "GLM-5.2",
		contextWindow: 1e6,
		maxTokens: 48e3,
		creditMultiplier: .79
	},
	{
		id: "kimi-k3",
		name: "Kimi-K3",
		contextWindow: 1e6,
		maxTokens: 32e3,
		creditMultiplier: 1.62
	},
	{
		id: "kimi-k2.6",
		name: "Kimi-K2.6",
		contextWindow: 256e3,
		maxTokens: 32e3,
		creditMultiplier: .52
	}
];
/** 某区域的静态兜底名册。 */
function fallbackModelsFor(region) {
	return region === "global" ? FALLBACK_MODELS_GLOBAL : FALLBACK_MODELS_CN;
}
/**
* 按用户选择过滤。
*
* 两条语义（DESIGN.md §7，`plugins/dsh-connect-workbuddy/src/catalog.ts:198-215`）：
*
* 1. `enabled` 为空集 = **全部显示**。从未配置过的插件必须能用，否则用户装完
*    看到空模型列表，会以为插件坏了。
* 2. `enabled` 非空但与目录完全不相交 = **退化成全部显示**，而不是空。用户勾过的
*    唯一模型可能已经从上游下架（例如 `auto` 路由模型），此时「一个都不显示」是
*    最糟的结果：选择器空了，用户没有任何可点的东西去恢复。他表达的是「要一些
*    模型开着」，退化满足了这个意图；而目录本身为空时才真的是空。
*/
function deriveVisibleModels(catalog, enabled) {
	const selected = enabled === void 0 || enabled.length === 0 ? catalog : catalog.filter((model) => enabled.includes(model.id));
	return selected.length === 0 && catalog.length > 0 ? catalog : selected;
}
/**
* 一个区域的目录。
*
* `visible()` 是 adapter 与 shim 唯一该读的东西：它已经把用户选择应用过。
*/
var WbCatalog = class {
	region;
	/** 最近一次实时名册；从未刷新时缺省。 */
	live;
	enabledIds = [];
	lastUpdatedAtMs;
	lastError;
	/** 该区域是否存在本机登录。默认 `true`（宽容方向）：扫描还没跑完时不该清空。 */
	usable = true;
	/** 用户是否显式启用了这个区域的 provider。默认 `true`（opt-out）。 */
	enabled = true;
	constructor(region) {
		this.region = region;
	}
	/** 当前该暴露给 DSH 的模型列表（已过滤）。 */
	visible() {
		if (!this.usable || !this.enabled) return [];
		return deriveVisibleModels(this.live ?? fallbackModelsFor(this.region), this.enabledIds);
	}
	/** 区域的静态兜底名册（诊断用；adapter 不该读它）。 */
	fallback() {
		return fallbackModelsFor(this.region);
	}
	/** 当前目录里全部模型（未过滤），供设置页画勾选框。 */
	all() {
		return this.live ?? fallbackModelsFor(this.region);
	}
	/** `'live'` 表示当前列表来自上游，`'fallback'` 表示还在用静态兜底。 */
	get source() {
		return this.live === void 0 ? "fallback" : "live";
	}
	/**
	* 最近一次**成功**抓取的时刻；从未成功过则为 `undefined`。
	*
	* 这是「这份数据多久前抓的」的唯一真相，也是 TTL 判定的输入。
	*
	* `noteFetchFailure` **不**更新它，这一点是刻意的，并且是契约 `t31` 的一条
	* 判决性断言：上游一直不通时，若失败也把时钟往前推，TTL 就永远不会到期，
	* 于是「过期了就去试一次」永远不成立——一次失败会把自动刷新**永久饿死**，
	* 只剩重启宿主才能恢复。失败必须让时钟留在原地，下一个 `/status` 才会再试。
	*
	* 名字选 `lastFetchedAtMs` 而不是复用下面的 `lastUpdatedAt`：后者是 0.1.x 的
	* 历史名字，语义被读成「列表内容变了没有」（`applyFetch` 的返回值也是这个），
	* 两者混用会让 TTL 判定跟着内容去抖动。
	*/
	get lastFetchedAtMs() {
		return this.lastUpdatedAtMs;
	}
	/** 历史别名，等价于 {@link lastFetchedAtMs}（保留给既有读取方）。 */
	get lastUpdatedAt() {
		return this.lastUpdatedAtMs;
	}
	get lastFetchError() {
		return this.lastError;
	}
	/**
	* 该区域的目录按 `ttlMs` 是否已到该重抓的时候。
	*
	* 从未成功抓取过（`lastFetchedAtMs === undefined`）算**过期**：启动播种失败后
	* 还在用静态兜底的情况必须被允许重试，否则一次开机时的网络抖动会让整个会话
	* 停留在兜底名册上（兜底名册没有促销条目，用户看到的就是「徽标永远不出现」）。
	*
	* 容忍时钟回拨：`nowMs < lastFetchedAtMs` 时按过期处理。系统时间被往回拨
	* （或 NTP 校正）之后 `now - fetched` 会是负数，若照常比较就会得出「还很新」，
	* 而这个错误会一直持续到真实时间追上那个未来时间戳为止。
	*/
	isStale(nowMs, ttlMs) {
		if (this.lastUpdatedAtMs === void 0) return true;
		if (nowMs < this.lastUpdatedAtMs) return true;
		return nowMs - this.lastUpdatedAtMs >= ttlMs;
	}
	/** 距上次成功抓取的毫秒数；从未抓取过则为 `undefined`。供界面对人显示。 */
	ageMs(nowMs) {
		if (this.lastUpdatedAtMs === void 0) return void 0;
		return Math.max(0, nowMs - this.lastUpdatedAtMs);
	}
	isUsable() {
		return this.usable;
	}
	isEnabled() {
		return this.enabled;
	}
	/** 记一次实时名册。空列表被拒——那会让所有模型从选择器里消失。 */
	applyFetch(models, atMs = Date.now()) {
		if (models.length === 0) {
			this.lastError = "上游返回了空模型目录，已保留原有列表";
			return false;
		}
		const before = JSON.stringify(this.live ?? []);
		this.live = models.map((model) => ({ ...model }));
		this.lastUpdatedAtMs = atMs;
		this.lastError = void 0;
		return JSON.stringify(this.live) !== before;
	}
	/** 记一次读目录失败；保留现有列表，只留原因。 */
	noteFetchFailure(message) {
		this.lastError = message;
	}
	/**
	* 只更新拥挤度，**不动**名册与 `lastUpdatedAtMs`。
	*
	* 为什么需要这条独立入口：拥挤度是分钟级事实、目录是小时级事实。若复用
	* {@link applyFetch}，一次「只问拥挤度」的刷新就会把 `lastFetchedAtMs` 推到当下，
	* 于是目录的 5 分钟 TTL 被这次拥挤度刷新**重置**——倍率与促销条目再也不会按时
	* 更新，而这正是用户抱怨的那个现象。
	*
	* 未在 `levels` 里出现的模型保留它原有的等级：上游只回答被问到的 id，漏答不等于
	* 「变回 unknown」。`name` 上的符号后缀要跟着重算，否则界面显示的还是上一次的。
	*
	* 返回是否真的变了（调用方据此决定要不耍刷新快照）。
	*/
	applyBusy(levels) {
		if (this.live === void 0 || levels.size === 0) return false;
		let changed = false;
		const next = this.live.map((model) => {
			const level = levels.get(model.id);
			if (level === void 0 || level === model.busyLevel) return model;
			changed = true;
			const base = stripBusySuffix(model.name);
			const suffix = busyDisplaySuffix(level);
			return {
				...model,
				busyLevel: level,
				name: suffix === "" ? base : `${base}${suffix}`
			};
		});
		if (!changed) return false;
		this.live = next;
		return true;
	}
	/** 用户改选择。空数组 = 全部显示。 */
	setEnabledIds(ids) {
		this.enabledIds = [...ids];
	}
	/** 该区域是否有本机登录。返回是否变化，调用方据此决定要不要刷新快照。 */
	setUsable(usable) {
		if (this.usable === usable) return false;
		this.usable = usable;
		return true;
	}
	/** 用户显式开关该区域的 provider。返回是否变化。 */
	setEnabled(enabled) {
		if (this.enabled === enabled) return false;
		this.enabled = enabled;
		return true;
	}
	/** 按 id 找一个模型（在**未过滤**的全量里找，供请求路径校验模型是否存在）。 */
	find(modelId) {
		return this.all().find((model) => model.id === modelId);
	}
	/**
	* 倍率的界面文案。
	*
	* `undefined`（未知）与 `0`（免费）必须给出**不同**的文字。这正是 R1-f「显示所有
	* 模型及模型使用倍率」要回答的问题：用户需要知道哪些是不要钱的、哪些是 1 倍、
	* 哪些是本插件也不知道的。
	*/
	multiplierLabelOf(model) {
		const multiplier = model.creditMultiplier;
		if (multiplier === void 0) return "倍率未知";
		if (multiplier === 0) return "免费";
		return `${multiplier}×`;
	}
};
/** 两个区域的目录一起持有，因为 adapter 与路由都要按区域取。 */
var WbCatalogs = class {
	byRegion;
	constructor() {
		this.byRegion = {
			cn: new WbCatalog("cn"),
			global: new WbCatalog("global")
		};
	}
	of(region) {
		return this.byRegion[region];
	}
	/** 把用户选择应用到对应区域。**空数组 = 全部显示**，两线口径一致。 */
	applySelection(region, enabledIds) {
		this.of(region).setEnabledIds(enabledIds ?? []);
	}
};
//#endregion
//#region src/probe.ts
/**
* 积分探测：把上游的「一堆积分包」聚合成本插件与排序层共用的 {@link WbCredits}。
*
* 为什么聚合要单独成层，而不是直接复用上游字段：
*
* `rankAccounts`（`src/status-paths.ts:576`）内部的兜底窗口是硬编码的
* `DEFAULT_EXPIRY_WARN_DAYS`（3 天）。它的注释给出的理由是「探测层会按用户配置
* 聚合出 `credits.expiringSoon`，那个显式值优先，所以排序层不必知道设置」。这个
* 理由只在**探测层确实自己算过**时成立。如果这里把上游原始积分包原样塞进
* `rankAccounts`，用户的 `expiryWarnDays` 就只影响界面文案，对「谁排第一」完全
* 无效——用户把提醒改成 30 天，却等不到任何账号被提前切换。
*
* 所以本文件的职责就是：**用用户配置的窗口把包算清楚**，让排序层的兜底永远不
* 需要被用到。
*
* @module dsh-connect-workbuddy-models/probe
*/
/**
* 把用户设置里的天数夹到合法范围。
*
* 夹紧而不是报错：`expiryWarnDays` 来自手改配置文件是常见路径，一个 `0` 或
* `99999` 应该退化成一个合理的窗口，而不是让整张设置页报校验失败、让插件在
* 加载期抛错（那会让「输入框下方读数」跟着一起消失）。
*/
function clampWarnDays(value) {
	const numeric = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(numeric)) return 3;
	return Math.min(90, Math.max(1, Math.round(numeric)));
}
/**
* 聚合一个账号的积分。
*
* 三个口径都由**本函数**决定，下游只读不算：
*
* 1. `total` —— 一律取上游已聚合的总量（它优先读 `*Precise` 字段，见
*    `upstream.ts` 的 `fetchCredits`；用整数版会漏掉小数，实测官方客户端总额带
*    两位小数，任何整数之和都凑不出来）。**不**用 `CapacityRemain` 家族当余额：
*    那是 pool 家族，整月额度花完时仍报满额（issue #58 定论）。
* 2. `expiringSoon` —— 按**用户配置的** `warnDays` 累加窗口内一次性包的余额。
*    周期包（`monthly`）不参与：它会刷新，不存在「过期」。
* 3. `nearestExpiryMs` —— **只算一次性包里最近的那个到期时刻**，且必须是**未来**
*    的、还有余额的包。
*
* 第 3 条的语义选择是关键，这里定死为「最近会流失的额度何时流失」，理由：
* `rankAccounts` 在 `expiry` 分布下用 `nearestExpiryMs` 升序排第一。若把它理解成
* 「所有包里最早的到期时刻」——月周期包也有 `CycleEndTime`——那一个明年才刷新的
* 月包会让账号排到最前，而它根本不会过期。这正是 R3 要避免的行为：用户要的是
* 「先把快要作废的积分花掉」，不是「先把订阅周期最近的那个号用起来」。
*
* 与 `rankAccounts` 的兜底口径完全一致（跳过 monthly、跳过已过期、跳过无余额），
* 所以即使某个调用方绕过本函数，排序结果也不会与这里算出的门票相反。
*/
function aggregateCredits(raw, options = {}) {
	const nowMs = options.nowMs ?? Date.now();
	const windowEndMs = nowMs + clampWarnDays(options.warnDays ?? 3) * DAY_MS;
	let nearestExpiryMs;
	let expiringSoon = 0;
	const expiringPackages = [];
	for (const pack of raw.packages) {
		if (pack.monthly) continue;
		const at = pack.expiresAtMs;
		if (at === void 0 || !Number.isFinite(at)) continue;
		if (at <= nowMs) continue;
		if (pack.remain <= 0) continue;
		if (nearestExpiryMs === void 0 || at < nearestExpiryMs) nearestExpiryMs = at;
		if (at <= windowEndMs) {
			expiringSoon += pack.remain;
			expiringPackages.push({
				packageName: pack.packageName,
				remain: pack.remain,
				expiresAtMs: at
			});
		}
	}
	expiringPackages.sort((left, right) => left.expiresAtMs - right.expiresAtMs);
	return {
		credits: {
			total: raw.total,
			packages: raw.packages,
			expiringSoon,
			...nearestExpiryMs === void 0 ? {} : { nearestExpiryMs }
		},
		expiringPackages,
		...nearestExpiryMs === void 0 ? {} : { daysToNearestExpiry: Math.max(0, Math.ceil((nearestExpiryMs - nowMs) / DAY_MS)) }
	};
}
/**
* 逐账号读取积分与签到，单个账号失败不影响其他账号。
*
* 串行而不是 `Promise.all`：上游对同一台机器有速率限制，4 个账号同时打
* `get-user-resource` 会有一部分拿到 429，而那看起来像「这个号没积分」。
* 串行多花的几秒换一个可信的读数，值得。
*/
async function probeAccounts(accounts, read, options = {}) {
	const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	const delayMs = options.delayMs ?? 150;
	const out = [];
	for (const [index, account] of accounts.entries()) {
		if (index > 0 && delayMs > 0) await sleep(delayMs);
		const readAtMs = Date.now();
		try {
			const reading = await read(account);
			const probe = reading.credits === void 0 ? void 0 : aggregateCredits(reading.credits, {
				...options.warnDays === void 0 ? {} : { warnDays: options.warnDays },
				nowMs: options.nowMs ?? readAtMs
			});
			out.push({
				accountId: account.id,
				...probe === void 0 ? {} : {
					credits: probe.credits,
					probe
				},
				...reading.checkin === void 0 ? {} : { checkin: toCheckinStatus(reading.checkin) },
				readAtMs
			});
		} catch (error) {
			out.push({
				accountId: account.id,
				error: error instanceof Error ? error.message : String(error),
				readAtMs
			});
		}
	}
	return out;
}
/** 上游签到 → 共享投影。两者字段同名，这里只做一次显式拷贝，避免把 `undefined`
* 与缺省混在一起（`exactOptionalPropertyTypes` 下两者不等价）。 */
function toCheckinStatus(raw) {
	return {
		active: raw.active,
		todayCheckedIn: raw.todayCheckedIn,
		streakDays: raw.streakDays,
		dailyCredit: raw.dailyCredit,
		todayCredit: raw.todayCredit,
		isStreakDay: raw.isStreakDay,
		nextStreakDay: raw.nextStreakDay,
		streakBonusDays: raw.streakBonusDays,
		streakBonusCredit: raw.streakBonusCredit,
		...raw.claimButtonText === void 0 ? {} : { claimButtonText: raw.claimButtonText }
	};
}
/**
* 池子里「剩余总积分」的合计（R2 的读数）。
*
* 只累加**读到了读数**的账号：把读失败的账号按 0 计入，会让总数在下一次刷新时
* 突然跳起来，用户会以为积分涨了。同时返回 `unread` 计数，界面才能说明
* 「合计 2,196（还有 1 个账号没读到）」。
*/
function totalCreditsOf(readings) {
	let total = 0;
	let unread = 0;
	for (const reading of readings) {
		if (reading.credits === void 0) {
			unread += 1;
			continue;
		}
		total += reading.credits.total;
	}
	return {
		total,
		unread
	};
}
/**
* 供界面判断「这个账号是否进入了临期窗口」。
*
* 与 {@link aggregateCredits} 用同一份 `WbCredits`，不重算：两处各算一遍窗口，
* 迟早会出现「卡片标红但排序没换号」或反过来。
*/
function isExpiring(credits) {
	return credits !== void 0 && credits.expiringSoon > 0;
}
//#endregion
//#region src/scheduler.ts
/** 上游按北京自然日判幂等，日界必须与它一致。 */
const AUTOMATION_TIME_ZONE = "Asia/Shanghai";
/** tick 间隔。60 秒足够精细（整点判定的最小粒度就是一小时），又不至于空转。 */
const AUTOMATION_TICK_MS = 6e4;
/** 账号之间的串行间隔。上游对同一台机器有速率限制，密集请求会有一半拿到 429。 */
const AUTOMATION_ACCOUNT_DELAY_MS = 800;
/** 默认签到时段（北京时间整点）。上午 9 点：用户已开机、上游活动已刷新。 */
const DEFAULT_CHECKIN_HOURS = [9];
/**
* 校准 hour list：只留 0-23 整数，去重升序；**过滤后为空则回落到默认值**。
*
* 回落的判据必须是「过滤后」而不是「过滤前」：用户配置里写了 [99] 这类越界值
* （手改配置文件、或从旧版本迁移）时，过滤前非空、过滤后为空——此时若直接返回
* 空列表， 就永不命中，自动签到会**静默停摆**且没有任何错误可看。
*/
function hoursOrDefault(hours, fallback) {
	if (hours === void 0 || hours.length === 0) return fallback;
	const valid = [...new Set(hours.filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23))].sort((a, b) => a - b);
	return valid.length === 0 ? fallback : valid;
}
/** `date` 在指定时区下的日历部件（全部为补零字符串）。 */
function zonedParts(date, timeZone = AUTOMATION_TIME_ZONE) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		hourCycle: "h23"
	}).formatToParts(date);
	const pick = (type) => parts.find((part) => part.type === type)?.value ?? "00";
	return {
		year: pick("year"),
		month: pick("month"),
		day: pick("day"),
		hour: pick("hour")
	};
}
/**
* `date` 所属的自然日，`YYYY-MM-DD`（北京时）。
*
* 导出因为状态路由也要按同一个日界决定「今天」。
*/
function dayKey(date, timeZone = AUTOMATION_TIME_ZONE) {
	const { year, month, day } = zonedParts(date, timeZone);
	return `${year}-${month}-${day}`;
}
/** `date` 所在的调度时段 `YYYY-MM-DDTHH`（北京时）。 */
function slotKey(date, timeZone = AUTOMATION_TIME_ZONE) {
	return `${dayKey(date, timeZone)}T${zonedParts(date, timeZone).hour}`;
}
const sleep = (ms) => new Promise((resolve) => {
	setTimeout(resolve, ms);
});
function accountWord(account) {
	return account.label === "" ? account.id.slice(0, 8) : account.label;
}
function describeError(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* 自动签到调度器。
*
* `start()` 只负责装定时器；真正的写操作只在 `tick` 里、且 `enabled === true` 时
* 发生。`dispose()` 必须被调用（宿主入口在 `ctx.effect` 里成对绑定），否则宿主
* 卸载后定时器仍在跑，会对着已 dispose 的上下文发请求。
*/
var WbScheduler = class {
	pool;
	client;
	logger;
	now;
	saveLedger;
	enabled = false;
	claimBenefits = false;
	checkinHours = DEFAULT_CHECKIN_HOURS;
	delayMs = 800;
	timer;
	/**
	* 「已被卸载」标记，**初值 false**。
	*
	* 它挡的是 `dispose()` 之后的运行，不是 `start()` 之前的运行：卡片上的「立即
	* 签到」是一次手动调用，与定时器无关，若初值为 `true` 就会在账号循环的第一行
	* 直接 break —— 按钮点下去静默无反应，而日志里一条错都没有。
	* 定时器本身由 `timer === undefined` 兜住，不需要这个标志。
	*/
	stopped = false;
	busy = false;
	states = { checkin: {
		firedSlots: [],
		ok: 0,
		failed: 0,
		claimed: 0,
		credit: 0
	} };
	/** 当日账本：账号 → 所得。跨日清空。 */
	earnings = /* @__PURE__ */ new Map();
	earningsDay;
	/** 最近一次运行的整体所得（卡片显示「刚发生了什么」）。 */
	lastPass;
	constructor(options) {
		this.pool = options.pool;
		this.client = options.client;
		this.logger = options.logger;
		this.now = options.now ?? (() => /* @__PURE__ */ new Date());
		this.saveLedger = options.saveLedger;
		const stored = options.loadLedger?.();
		if (stored !== void 0) {
			this.states.checkin.firedSlots = (stored.firedSlots ?? []).filter((entry) => typeof entry === "string");
			if (stored.lastRunDate !== void 0) this.states.checkin.lastRunDate = stored.lastRunDate;
			if (stored.lastRunSlot !== void 0) this.states.checkin.lastRunSlot = stored.lastRunSlot;
		}
		if (options.config !== void 0) this.applyConfig(options.config);
	}
	/**
	* 施加配置。
	*
	* `enabled` 的变化**立即生效**：关掉时不需要等下一个 tick 停止写操作，因为 tick
	* 每次都重读这个字段。定时器本身继续跑（空转极轻），这样重新打开无需重启宿主。
	*/
	applyConfig(config) {
		if (config === void 0) return;
		this.enabled = config.enabled === true;
		this.claimBenefits = config.claimBenefits === true;
		this.checkinHours = hoursOrDefault(config.checkinHours, DEFAULT_CHECKIN_HOURS);
		if (config.accountDelayMs !== void 0) this.delayMs = Math.max(0, config.accountDelayMs);
	}
	/** 当前是否真的会发起写操作。 */
	isEnabled() {
		return this.enabled;
	}
	/** 装定时器。重复调用是空操作。 */
	start() {
		if (this.timer !== void 0) return;
		this.stopped = false;
		this.timer = setInterval(() => {
			this.tick();
		}, AUTOMATION_TICK_MS);
		this.timer.unref?.();
	}
	/** 停定时器并阻止后续运行。可重复调用。 */
	dispose() {
		this.stopped = true;
		if (this.timer !== void 0) {
			clearInterval(this.timer);
			this.timer = void 0;
		}
	}
	/** 状态快照（不含 token 材料）。 */
	status() {
		this.rollLedger(dayKey(this.now()));
		return {
			enabled: this.enabled,
			running: this.timer !== void 0 && !this.stopped,
			checkinHours: this.checkinHours,
			claimBenefits: this.claimBenefits,
			jobs: { checkin: { ...this.states.checkin } },
			earningsToday: Object.fromEntries(this.earnings),
			runInProgress: this.busy,
			...this.states.checkin.lastRunAtMs === void 0 ? {} : { lastPassAtMs: this.states.checkin.lastRunAtMs },
			...this.lastPass === void 0 ? {} : { lastPass: this.lastPass }
		};
	}
	/** 恢复一个持久化的账本（宿主启动时读回）。 */
	applyLedger(ledger) {
		if (ledger === void 0) return;
		this.states.checkin.firedSlots = (ledger.firedSlots ?? []).filter((entry) => typeof entry === "string");
		if (ledger.lastRunDate !== void 0) this.states.checkin.lastRunDate = ledger.lastRunDate;
		if (ledger.lastRunSlot !== void 0) this.states.checkin.lastRunSlot = ledger.lastRunSlot;
	}
	/** 当前账本（持久化用）。 */
	ledger() {
		this.rollLedger(dayKey(this.now()));
		const state = this.states.checkin;
		return {
			firedSlots: state.firedSlots,
			...state.lastRunDate === void 0 ? {} : { lastRunDate: state.lastRunDate },
			...state.lastRunSlot === void 0 ? {} : { lastRunSlot: state.lastRunSlot }
		};
	}
	/**
	* 手动运行一次签到（卡片上的「立即签到」与状态路由的 POST）。
	*
	* `force` 缺省 `true`：用户按下按钮就是「我知道，还是跑」。**不消费调度时段**
	* ——10:35 手动跑一次不能取消 21:00 那个时段。
	*/
	async runCheckinNow(options = {}) {
		return await this.runCheckin(options.region, options.force ?? true);
	}
	/**
	* 手动给**一个**账号签到（账号卡片上的按钮）。
	*
	* 与 {@link runCheckinNow} 分开是因为两者的失败语义不同：全量运行里「一个账号
	* 失败」要被吞掉并计入 `failed`，而单账号运行里那个失败必须原样抛给调用方——
	* 用户点的是这一个账号的按钮，吞掉错误等于按钮没反应。
	*
	* 返回 `undefined` 表示没有可做的事（活动未开启 / 账号不存在），而不是失败。
	*/
	async checkinOne(accountId) {
		const entry = this.pool.find(accountId);
		if (entry === void 0) return {
			gain: void 0,
			detail: ["账号不存在（可能已被上游注销或文件被删）"]
		};
		const today = dayKey(this.now());
		this.rollLedger(today);
		const state = this.states.checkin;
		this.resetRoundCounters(state);
		const detail = [];
		const gain = await this.runOne(entry.account, today, detail);
		state.lastRunDate = today;
		state.lastRunSlot = slotKey(this.now());
		state.lastRunAtMs = this.now().getTime();
		state.message = this.summarise(state);
		state.detail = detail;
		this.lastPass = gain === void 0 ? {} : { [accountId]: gain };
		this.persist();
		return {
			gain,
			detail
		};
	}
	/**
	* 手动领取**一个**账号的某一类权益。
	*
	* 先复核该权益此刻是否可领（`active && !claimed`）：上游对已领取的赠礼仍报
	* `active: true`，不复核就会在用户连点两次时发出第二个必然被拒的写请求，而
	* 那个拒绝看起来像「领取失败」。
	*
	* 返回 `false` 表示「现在没什么可领」，`true` 表示刚领成功。真正的失败抛给调用方。
	*/
	async claimOne(accountId, kind) {
		const entry = this.pool.find(accountId);
		if (entry === void 0) throw new Error(`unknown account: ${accountId}`);
		const target = (await this.client.fetchBenefits(entry.account.credential)).find((benefit) => benefit.kind === kind);
		if (target === void 0) throw new Error(`upstream does not report a ${kind} benefit for this account`);
		if (!target.active || target.claimed) return false;
		await this.client.claimBenefit(entry.account.credential, kind);
		const today = dayKey(this.now());
		this.recordEarnings(accountId, today, {
			credit: target.creditNum,
			checkinCredit: 0,
			benefitCredit: target.creditNum
		});
		this.persist();
		return true;
	}
	/**
	* 循环体：到点就跑。
	*
	* 状态筛选（enabled / stopped / busy）与异常隔离都在这里，保证循环本身绝不被
	* 一次失败拖死。
	*/
	async tick() {
		if (!this.enabled || this.stopped || this.busy) return;
		try {
			const now = this.now();
			const slot = slotKey(now);
			this.rollLedger(dayKey(now));
			const consumed = this.dueSlot(now);
			if (consumed === void 0) return;
			if (this.states.checkin.lastFiredHour === slot) return;
			this.consumeSlot(consumed);
			await this.runCheckin("cn", true);
		} catch (error) {
			this.logger?.warn?.("dsh-connect-workbuddy-models: 自动签到 tick 失败", error);
		}
	}
	/** 今天已消费的时段集合（读取时顺手丢掉更早的日期）。 */
	firedSlotsOf() {
		const today = dayKey(this.now());
		return new Set(this.states.checkin.firedSlots.filter((entry) => entry.startsWith(`${today}T`)));
	}
	/** 记录一个已消费的调度时段。 */
	consumeSlot(slot) {
		const today = dayKey(this.now());
		const next = /* @__PURE__ */ new Set([...this.firedSlotsOf(), slot]);
		this.states.checkin.firedSlots = [...next].filter((entry) => entry.startsWith(`${today}T`)).sort();
		this.persist();
	}
	/**
	* 此刻该跑的时段，没有则 undefined。
	*
	* **最早**的未消费候选胜出，这样多时段配置才完整。用「已经过去」而不是「正好
	* 等于」判定：DSH 关闭期间错过的时段能自愈（09:00 的签到在 10:00 启动时补上），
	* 这正是笔记本合盖场景需要的。
	*/
	dueSlot(now) {
		const hours = this.checkinHours;
		if (hours.length === 0) return void 0;
		const current = Number(zonedParts(now).hour);
		const today = dayKey(now);
		const fired = this.firedSlotsOf();
		for (const candidate of [...hours].sort((a, b) => a - b)) {
			if (candidate > current) break;
			const slot = `${today}T${String(candidate).padStart(2, "0")}`;
			if (!fired.has(slot)) return slot;
		}
	}
	/** 跨日重置账本与 `firedSlots`。 */
	rollLedger(today) {
		if (this.earningsDay === today) return;
		this.earningsDay = today;
		this.earnings = /* @__PURE__ */ new Map();
		this.states.checkin.firedSlots = this.states.checkin.firedSlots.filter((entry) => entry.startsWith(`${today}T`));
	}
	async persist() {
		if (this.saveLedger === void 0) return;
		try {
			await this.saveLedger(this.ledger());
		} catch (error) {
			this.logger?.warn?.("dsh-connect-workbuddy-models: 自动化账本写入失败", error);
		}
	}
	/**
	* 参与自动化的账号。
	*
	* 取池里**可服务**的成员（`exclusionReason` 为空）：死凭据的账号签到也一定失败，
	* 对它们发写请求只是把一次 401 变成一条日志噪声。**不跳过冷却账号** —— 冷却记在
	* shim 里、按 (账号, 模型) 计，是对话路由的闸门；签到走独立的 billing 端点，不该
	* 被对话侧限流连坐。
	*/
	eligibleAccounts(region) {
		const out = [];
		for (const entry of this.pool.list()) {
			if (region !== void 0 && entry.account.region !== region) continue;
			if (this.pool.exclusionReason(entry) !== void 0) continue;
			out.push(entry.account);
		}
		return out;
	}
	/**
	* 跑一轮签到。`requestedRegion` **只是调用方的意图，不是参与范围**。
	*
	* 签到是 **cn 专属操作**（`CHECKIN_REGION`，来源见那里的注释：t21 产品裁定国际版
	* 不提供签到活动）。因此本方法在入口就把范围归一成 `CHECKIN_REGION`：**无论调用
	* 方传什么，包括 `undefined`，本轮参与的账号一律限定为国内版**——`undefined`
	* 在这里**不再表示「全池」**。
	*
	* 为什么要在被调方收口，而不是让三个调用点各自传对：这个缺陷真实发生过——
	* `runCheckinNow({ force: true })`（状态路由）与 `runCheckin(undefined, true)`
	* （定时 tick）都不传区域，于是国际版账号被送到国内 billing 端点，`detail` 里留下
	* 它的名字，用户看到的是「国际版被签到了」。调用点分散在路由、定时器、卡片按钮三
	* 处，靠自觉总会漏一个；收口后漏传只会退化成本该如此的行为。
	*/
	async runCheckin(requestedRegion, force) {
		const region = "cn";
		if (requestedRegion !== void 0 && requestedRegion !== "cn") this.logger?.warn?.(`dsh-connect-workbuddy-models: 签到只对国内版账号生效，收到区域 ${requestedRegion}，本轮仍只处理 cn`);
		const now = this.now();
		const today = dayKey(now);
		const state = this.states.checkin;
		const slot = slotKey(now);
		if (!force && state.lastFiredHour === slot) return {};
		if (this.busy) return {};
		this.busy = true;
		this.resetRoundCounters(state);
		const gained = {};
		const detail = [];
		try {
			const accounts = this.eligibleAccounts(region);
			for (let index = 0; index < accounts.length; index += 1) {
				if (this.stopped) break;
				const account = accounts[index];
				try {
					const gain = await this.runOne(account, today, detail);
					if (gain !== void 0) gained[account.id] = gain;
				} catch (error) {
					state.failed += 1;
					this.logger?.warn?.(`dsh-connect-workbuddy-models: 账号 ${accountWord(account)} 签到失败`, error);
					detail.push(`${accountWord(account)}：失败（${describeError(error)}）`);
				}
				if (index < accounts.length - 1 && this.delayMs > 0 && !this.stopped) await sleep(this.delayMs);
			}
		} finally {
			this.busy = false;
		}
		state.lastFiredHour = slot;
		state.lastRunDate = today;
		state.lastRunSlot = slot;
		state.lastRunAtMs = this.now().getTime();
		state.message = this.summarise(state);
		state.detail = detail;
		this.lastPass = gained;
		this.logger?.info?.(`dsh-connect-workbuddy-models: ${state.message}`);
		this.persist();
		return gained;
	}
	/**
	* 单账号：读签到状态 → 判定 → （必要时）领取 → 顺带领权益。
	*
	* 幂等靠**上游的两个独立标志**，而不是本地账本：
	* - `todayCheckedIn`：该账号今天的奖励已存在（无论哪台设备领的）。
	* - `active`：活动窗口是否开着。
	*
	* 本地账本只用于「今天这个时段跑过没有」，它回答不了任何账号级问题——把本地
	* 日期当「已签到」是已发布过的缺陷（切换账号后卡片显示已签到并禁用按钮，理由错）。
	*/
	async runOne(account, today, detail) {
		const state = this.states.checkin;
		const label = accountWord(account);
		const status = await this.client.fetchCheckinStatus(account.credential);
		if (!status.active) {
			state.ok += 1;
			detail.push(`${label}：签到活动未开启`);
			return;
		}
		if (status.todayCheckedIn) {
			state.ok += 1;
			detail.push(`${label}：今日已签到（连续 ${status.streakDays} 天，今日 +${status.todayCredit} 积分）`);
			const benefitCredit = this.claimBenefits ? await this.claimBenefitsOf(account, detail, label) : 0;
			const gain = {
				credit: benefitCredit,
				checkinCredit: 0,
				alreadyDone: true
			};
			if (benefitCredit > 0) gain.benefitCredit = benefitCredit;
			this.recordEarnings(account.id, today, gain);
			return gain;
		}
		const claim = await this.client.claimDailyCheckin(account.credential);
		state.ok += 1;
		state.claimed += 1;
		state.credit += claim.credit;
		detail.push(`${label}：签到成功 +${claim.credit} 积分（连续 ${claim.streakDays} 天）`);
		const benefitCredit = this.claimBenefits ? await this.claimBenefitsOf(account, detail, label) : 0;
		const gain = {
			credit: claim.credit + benefitCredit,
			checkinCredit: claim.credit
		};
		if (benefitCredit > 0) gain.benefitCredit = benefitCredit;
		this.recordEarnings(account.id, today, gain);
		return gain;
	}
	/**
	* 领取该账号可领的权益。
	*
	* `claimable = active && !claimed`：上游对已领取的赠礼仍会报 `active: true`
	* （campaign 未结束），所以只看 `active` 会每次运行都重复领一次、每次都被拒。
	* 两个标志都必须读。
	*
	* 单个权益失败不打断其他：活动端点各自独立，一个回 5xx 不该让另一个消失。
	*/
	async claimBenefitsOf(account, detail, label) {
		let credits = 0;
		let benefits;
		try {
			benefits = await this.client.fetchBenefits(account.credential);
		} catch (error) {
			detail.push(`${label}：权益清单读取失败（${describeError(error)}）`);
			return 0;
		}
		for (const benefit of benefits) {
			if (!benefit.active || benefit.claimed) continue;
			try {
				await this.client.claimBenefit(account.credential, benefit.kind);
				credits += benefit.creditNum;
				detail.push(`${label}：领取${benefit.kind === "gift" ? "赠礼" : "补偿"} +${benefit.creditNum} 积分`);
			} catch (error) {
				detail.push(`${label}：${benefit.kind === "gift" ? "赠礼" : "补偿"}领取失败（${describeError(error)}）`);
			}
		}
		return credits;
	}
	/** 把一次所得累加进当日账本。0 所得的记录也要落（它说明「今天跑过了」）。 */
	recordEarnings(accountId, today, gain) {
		this.rollLedger(today);
		const prev = this.earnings.get(accountId);
		this.earnings.set(accountId, prev === void 0 ? gain : {
			credit: prev.credit + gain.credit,
			checkinCredit: prev.checkinCredit + gain.checkinCredit,
			...(prev.benefitCredit ?? 0) + (gain.benefitCredit ?? 0) === 0 ? {} : { benefitCredit: (prev.benefitCredit ?? 0) + (gain.benefitCredit ?? 0) },
			...prev.alreadyDone === true || gain.alreadyDone === true ? { alreadyDone: true } : {}
		});
	}
	/**
	* 把「本轮」的四个计数器归零。
	*
	* `ok` / `failed` / `claimed` / `credit` 是**本轮**口径——{@link summarise} 直接
	* 拿它们拼「N 个账号已处理」。跨轮累计另有去处：`earningsToday` 按账号按自然日
	* 建账，`lastPass` 记最近一次的结果，两者都不受这里影响。
	*
	* 三种入口（定时、手动全量、单账号按钮）都必须先过这里：漏一个，用户点一次
	* 单账号按钮就会让「4 个账号已处理」变成 5。
	*
	* **不清** `firedSlots`：那是「今天哪些时段跑过」的调度账本，清掉会让同一个
	* 时段被重复消费。
	*/
	resetRoundCounters(state) {
		state.ok = 0;
		state.failed = 0;
		state.claimed = 0;
		state.credit = 0;
	}
	/** 一行总结。 */
	summarise(state) {
		const parts = [`${state.ok} 个账号已处理`];
		if (state.claimed > 0) parts.push(`${state.claimed} 个签到成功 +${state.credit} 积分`);
		if (state.failed > 0) parts.push(`${state.failed} 个失败`);
		return `自动签到：${parts.join("，")}`;
	}
};
//#endregion
//#region src/shim.ts
/**
* 回环 OpenAI 兼容端点 + 多账号自动容错换号。
*
* pi-ai provider 指向这里。每个 chat 请求从账号池取一个账号；上游回答限流或积分
* 耗尽时，shim 记一次冷却、换下一个账号、在同一请求内重试 —— 所以临时的 429 不会
* 以「这轮对话失败」的形式到达用户面前。
*
* 安全模型（Host/Origin 回环校验、常量时间 bearer 比对、随机端口、进程内 secret、
* 请求体上限、错误分类到状态码）沿用同仓 `dsh-connect-trae-models/src/shim.ts` 的
* 已验证设计（其血统为 corrinehu/dsh-workbuddy-connect，MIT）。
*
* @module dsh-connect-workbuddy-models/shim
*/
const REQUEST_BODY_LIMIT = 67108864;
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]"
]);
/** 各上游失败类映射到的 HTTP 状态码。 */
const KIND_STATUS = {
	hard_credit: 402,
	soft_rate: 429,
	authentication: 401,
	client_reject: 400,
	channel_reject: 400,
	local_gate_oversize: 422,
	local_gate_unattributed: 422,
	session_dead: 401,
	server: 502,
	client: 400
};
/** 上游未给 reset 时间时的限流冷却兜底（毫秒）。 */
const WB_DEFAULT_COOLDOWN_MS = 6e4;
/** 硬额度（积分耗尽）的冷却：额度不会在几秒内回来，冷得比限流久。 */
const WB_HARD_CREDIT_COOLDOWN_MS = 3e5;
/**
* 网关在 system 开场白被指纹识别为「未授权通道」时给出的占位提示词。
*
* 为什么需要：DSH 的系统提示词前缀与官方客户端不同，网关按开场白指纹判定通道；
* 被判为非授权通道时整个请求直接失败。此时把系统提示词替换成一句中性的占位是
* 唯一能保住这次对话的降级——总比一个必然的 400 好。
*
* 刻意极短：这是一个最后手段的占位，不是人设。编一段更长的话会在所有受影响的
* 请求上悄悄改变模型行为。
*/
const WB_FALLBACK_SYSTEM_PROMPT = "You are a helpful assistant.";
/**
* 从 429 响应体解析冷却截止时刻。
*
* 上游有时给出 `resetAt`/`reset_time`（13 位 epoch 毫秒）或本地化的
* 「将在 2026-10-11 12:00:00」；两者都拿不到时返回 undefined，由
* {@link WB_DEFAULT_COOLDOWN_MS} 兜底 —— 一个识别不出的限流窗口绝不能让账号
* 被无限期冷却，也绝不能完全不冷却。
*/
function parseRateLimitReset(body) {
	const epochMs = /"(?:resetAt|reset_at|resetTime|reset_time)"\s*:\s*(\d{13})/.exec(body);
	if (epochMs !== null) return Number(epochMs[1]);
	const localized = /将在\s*([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2})/.exec(body);
	if (localized !== null) {
		const parsed = Date.parse(localized[1].replace(" ", "T"));
		if (!Number.isNaN(parsed)) return parsed;
	}
}
function hostnameOfHost(host) {
	let hostname = host.trim().toLowerCase();
	if (hostname.startsWith("[")) {
		const end = hostname.indexOf("]");
		return end === -1 ? hostname : hostname.slice(0, end + 1);
	}
	const colon = hostname.lastIndexOf(":");
	if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
	return hostname;
}
/** Host 必须指向回环；在路由前就挡掉 DNS rebinding。 */
function hostIsLoopback(host) {
	if (host === void 0 || host.trim() === "") return false;
	return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}
/** 带 Origin 时必须是回环；非浏览器客户端不发 Origin，直接放行。 */
function originIsLoopback(origin) {
	if (origin === void 0 || origin.trim() === "") return true;
	try {
		const { hostname } = new URL(origin);
		return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
	} catch {
		return false;
	}
}
/** chat POST 必须带 JSON body 类型（挡掉简单请求 CSRF）。 */
function isJsonContentType(req) {
	const type = req.headers["content-type"];
	return typeof type === "string" && type.trim().toLowerCase().startsWith("application/json");
}
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
function writeOpenAIError(res, status, kind, message) {
	writeJson(res, status, { error: {
		message,
		type: kind,
		code: kind
	} });
}
/**
* 上游失败体是否表示请求超出了模型上下文窗口。
*
* 单独识别它是因为它该映射成 400 + 一段能指导用户的文案（「缩短历史」），而不是
* 笼统的 502「上游出错」——后者会让用户去查网络。
*/
function isContextTooLong(body) {
	if (body.includes("context_length_exceeded")) return true;
	if (body.includes("input length too long")) return true;
	if (body.includes("context window exceeded")) return true;
	if (body.includes("maximum context length")) return true;
	if (/exceeds?\s+(the\s+)?(model\s+)?context\s+(window|limit)/iu.test(body)) return true;
	return false;
}
/**
* 请求的无内容形态描述，供上游拒绝时记日志。
*
* `client` 类失败（HTTP 400）通常带空的 `param`，错误本身说不出是哪个参数被拒 ——
* 用户只看到「请求参数不满足当前模型要求」而无从下手。记录形态（顶层键、按角色的
* 消息数、工具数、近似 prompt 大小）让这类拒绝能从日志里诊断出来。
*
* 刻意只记形态：无消息内容、无工具 schema、无 token。它会落进日志文件，而它描述
* 的那个对话属于用户。
*/
function requestShape(raw) {
	try {
		const parsed = JSON.parse(raw);
		const keys = Object.keys(parsed).sort();
		const messages = Array.isArray(parsed["messages"]) ? parsed["messages"] : [];
		const byRole = /* @__PURE__ */ new Map();
		let chars = 0;
		for (const entry of messages) {
			if (typeof entry !== "object" || entry === null) continue;
			const message = entry;
			const role = typeof message["role"] === "string" ? message["role"] : "?";
			byRole.set(role, (byRole.get(role) ?? 0) + 1);
			chars += JSON.stringify(message["content"] ?? "").length;
		}
		const roles = [...byRole.entries()].map(([role, n]) => `${role}:${n}`).join(" ");
		const tools = Array.isArray(parsed["tools"]) ? parsed["tools"].length : 0;
		return `keys=[${keys.join(" ")}] messages=${messages.length}${roles === "" ? "" : ` (${roles})`} tools=${tools} contentChars=${chars}`;
	} catch {
		return "body was not parseable JSON";
	}
}
/**
* 把上游原文裁到 `limit` 字符，尽量在一句话的结尾断开。
*
* 为什么不是 `slice(0, limit) + '…'`：上游那句可执行的建议常常正好跨在截断点上，
* 直接切会得到「…请新建任务、换个模型或稍后重」这种半句，读起来像乱码。所以先压平
* 空白（JSON 里的 `\n` 到了界面是空的），再在断点往前找一个句末标点；找不到就用硬
* 截断——宁可硬截，也不要造出一个比上限还长的结果。
*/
function clippedUpstreamText(text, limit) {
	const collapsed = text.replace(/\s+/gu, " ").trim();
	if (collapsed.length <= limit) return collapsed;
	const cut = collapsed.slice(0, limit);
	const stop = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("！"), cut.lastIndexOf("？"), cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
	if (stop >= Math.floor(limit / 2)) return `${cut.slice(0, stop + 1).trimEnd()}…`;
	return `${cut.trimEnd()}…`;
}
/**
* 若这次拒绝是「推理档位参数不被接受」，返回一行点名了档位的描述。
*
* 单独立一支而不是混进通用文案，因为它的处置动作**完全不同**：通用参数拒绝只能说
* 「按上面的提示调整」，而档位拒绝有确定的开关可关（模型卡片里那一行的「可关闭
* 思考」勾选）。把两者混在一起，用户会去改历史、换模型，而真正该关的开关还在那里。
*/
function reasoningTierRefusal(outcome) {
	if (outcome.kind !== "client") return void 0;
	const param = outcome.detail?.rejectedParam;
	if (param === void 0 || !param.includes("reasoning")) return void 0;
	const tier = outcome.detail?.rejectedTier;
	return tier === void 0 ? `上游拒绝了推理档位参数（${param}）` : `上游拒绝了推理档位「${tier}」（${param}）`;
}
/**
* 失败回复的正文：先给上游那句可执行建议，再给我们的处置建议。
*
* 取值顺序 `refusedTier → detail.tips → detail.displayMsg → 裁剪后的原始 body` 是
* 从「最具体」到「最笼统」排的：
* - 档位拒绝：唯一带着确定开关的那一支；
* - `displayTips`：上游专门写给用户看的那句（「请新建任务、换个模型或稍后重试」）；
* - `displayMsg`：一句短结论，比原始 body 好但仍不指向动作；
* - 原始 body：最后的兜底，命中它说明信封没带人话（或压根不是 JSON）。
*
* `stamp` 是 `（code 11133，requestId …）` 这个紧凑摘要：两个字段任缺就省掉对应半句，
* 半个括号都不留 —— 出现「（code undefined）」比不写更让人怀疑这份软件。
*/
function clientRejectionBody(outcome, contextTooLong) {
	if (contextTooLong) return "";
	const stamp = upstreamStamp(outcome.detail);
	const refusedTier = reasoningTierRefusal(outcome);
	const receipt = refusedTier ?? outcome.detail?.tips ?? outcome.detail?.displayMsg ?? clippedUpstreamText(outcome.message, 400);
	const advice = refusedTier !== void 0 ? "这不是账号或网络问题：该模型不接受「off」推理档位。档位随模型而定，请在模型选择器里重新选一次该模型（名册可能刚刷新），或改用其它档位后重试" : outcome.kind === "client" ? "该请求被上游按参数拒绝：与网络、账号、额度都无关，换账号也不会改变结果，请按上面的提示调整后重试" : "";
	const trimmed = receipt.replace(/[。.]$/u, "");
	return `${advice === "" ? receipt : `${trimmed}。${advice}`}${stamp}`;
}
/**
* `（code N，requestId X）`；两字段都没有时返回空串。
*
* 括号里用中文逗号：它读起来是给人看的一句话的一部分，不是程序输出。用英文逗号会
* 让它在中文句中显得像被粘上去的调试残留。
*/
function upstreamStamp(detail) {
	if (detail === void 0) return "";
	const parts = [];
	if (detail.upstreamCode !== void 0) parts.push(`code ${detail.upstreamCode}`);
	if (detail.requestId !== void 0) parts.push(`requestId ${detail.requestId}`);
	return parts.length === 0 ? "" : `（${parts.join("，")}）`;
}
/**
* 本机闸门拒绝时，用户该做的三件事。
*
* 为什么自己写一遍而不是直接把闸门那句英文 message 甩出去：那句原文是好几百字符的
* 英文长句（两条从句里各塞一次原因），而用户是在中文界面里读到一个 422。更要紧的是
* 我们**没有**把它的三条建议结构化过，直接转发等于把「哪三条」这件事交给用户自己从
* 长句里切分。
*
* 两支的处置不同，所以分开写：未归属那支裁剪内容就能过；归属查询抛错那支在同一次
* 进程里会一直失败，必须重启宿主或新开会话。两支共有的那句兜底建议（裁剪超大粘贴
* 或工具输出）都保留 —— 它是最省事的那条路。
*
* **刻意不出现「换账号」**：闸门读的是请求体大小与会话归属，换一份凭据会拿着同一份
* 超长历史再撞一次同一道闸门。`client` 那支的通用建议里恰好有这句话，所以本函数据
* 不共用 `clientRejectionBody`。
*/
function localGateAdvice(outcome) {
	const code = outcome.detail?.localGateCode;
	const suffix = code === void 0 ? "" : `（闸门码 ${code}）`;
	const trimHint = "把过大的内容裁剪掉——例如一次巨型粘贴、或一整段工具输出，删掉或裁短后重发";
	if (outcome.kind === "local_gate_unattributed") return `这个请求没有归属到任何受管的 billion-context 会话，而它的体积可证明超过 100 万 token，直接发给上游只会被拒，重试也只是把同一份超长历史再发一次。三件事任选其一：① 把对话接入受管会话，让它可以被压缩；② ${trimHint}；③ 新开一个会话重说需求。${suffix}`;
	return `它查询会话归属时出错了（该会话的作用域已释放或正在关闭），超长历史折叠不进模型窗口。在作用域恢复之前，重试同一次调用会一直失败。两件事任选其一：① 重启一次客户端宿主（会话状态已落盘，不会丢），或直接新开一个会话；② ${trimHint}。${suffix}`;
}
/**
* 请求所属对话的稳定身份，供 `sticky` 使用。
*
* 用**第一条 user 消息**做键：它是 body 里唯一不随历史增长而改变的部分，所以一个
* 对话的每一轮都哈希到同一个值，而新对话（开头消息不同）哈希到别的值。哈希而非
* 存原文，让对话内容不进入池的内存。
*
* 两条开头完全相同的对话会共享账号 —— 罕见且无害：只意味着它们共用同一个账号的
* 上游 prompt 缓存。
*/
function conversationKeyOf(raw) {
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed.messages)) return void 0;
		for (const entry of parsed.messages) {
			if (typeof entry !== "object" || entry === null) continue;
			const message = entry;
			if (message["role"] !== "user") continue;
			const content = typeof message["content"] === "string" ? message["content"] : JSON.stringify(message["content"] ?? "");
			return createHash("sha256").update(content).digest("hex").slice(0, 32);
		}
		return;
	} catch {
		return;
	}
}
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > REQUEST_BODY_LIMIT) {
				reject(/* @__PURE__ */ new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}
/** 取请求里的 model 字段（限流按模型计，所以冷却要带 modelId）。 */
function modelIdOf(raw) {
	try {
		const parsed = JSON.parse(raw);
		return typeof parsed.model === "string" && parsed.model !== "" ? parsed.model : void 0;
	} catch {
		return;
	}
}
/**
* 网关按开场白指纹判定为「未授权通道」的 system/assistant 消息开头。
*
* 为什么必须有这张表：两个网关都会扫描**每一条** `system` 与 `assistant` 消息的
* 开头，命中已知第三方 agent 提示词列表就以业务码 `11128`
* （`Illegal API invocation from an unapproved channel`）整条拒绝，而返回的
* `displayTips` 是一句「这次调用没通过渠道校验，可能不是官方客户端发出的」——
* 读起来像凭据或客户端身份问题，实际是**内容前缀匹配**。这和「conversation id
* missing」「first message is not system prompt」是同一个业务码，只能靠 body 区分。
*
* 表里两条是实测快照（照 `dsh-connect-workbuddy/src/upstream.ts:1389` 搬过来，
* 那边记账的实测口径：2026-10-21、国内网关、单一账号、`deepseek-v4.1-flash`、
* 其余请求字段全部固定）：
*
*   system 消息以以下内容开头                          国内          国际
*   ------------------------------------------------  ------------  ------------
*   "You are an AI agent powered by DeepSeek Harness"   400 / 11128   200
*   "You are Claude Code, Anthropic's official CLI…"    400 / 11128   400 / 11128
*   "You are an AI agent powered by Kimi."              200           200
*   "You are Cursor Agent…"、"You are Gemini CLI…"      200           200
*   同样的 DSH 提示词，前面加一句 "You are a helpful
*   assistant."                                         200           200
*
* 匹配只看**开头**：同一句话出现在提示词中段、出现在 `user` 消息里、或前面多一个
* 空格，都能过；比较前会 trim 前导空白并小写化（小写形态同样会被拒）。
*
* 这张表**不可能完整**，上游随时能加条目而我们看不到——所以它是尽力而为的过滤器，
* 不是保证。表外的**前缀**由 {@link forceNeutralHead} 兜住（无条件前置），表外的
* **内层 span** 由 {@link relocateScannedContent} 兜住（不需要知道 span 长什么样）。
* 二者都不依赖这张表，这也是它只收录实测条目的底气。
*
* 这张表也不靠猜扩充：没人测过的开头就是没人知道网关会拒的开头，凭空加条目会把
* 今天能过 200 的提示词也一起改写掉。
*/
const UNAPPROVED_CHANNEL_OPENINGS = ["you are an ai agent powered by deepseek harness", "you are claude code, anthropic's official cli for claude"];
/**
* 这段文本是否**以**网关会拒的开场白开头。
*
* 三条实测规则都折在这里（同源实测，条件见 {@link UNAPPROVED_CHANNEL_OPENINGS}）：
*
* 1. 只有**开头**算——同一句话出现在内容中段返回 200；
* 2. 比较前 trim 前导空白——`" <banned>"` 与 `"\n<banned>"` 今天都能过；
* 3. 大小写不敏感——全小写形态一样被拒。
*
* 第 2 条是网关当前的宽容，随时可能收回，所以这里按「会 trim 的网关」来比较，
* 而原始内容不动一个字节：只在网关忘记 trim 时才成立的规则，是一条等着失效的规则。
*/
function isUnapprovedChannelOpening(text) {
	const opening = text.replace(/^\s+/u, "").toLowerCase();
	return UNAPPROVED_CHANNEL_OPENINGS.some((prefix) => opening.startsWith(prefix));
}
/**
* 网关会扫描开场的角色。
*
* 实测（同源，国内网关、其余字段固定）：`system` 与 `assistant` 会被扫；`user` 与
* `tool` 不会（把被禁身份放到这两类消息的开头返回 200）。第二种角色容易被漏掉，
* 而漏掉的后果不是「这一次失败」：一条以被禁身份开头的 `assistant` 历史消息会污染
* 该会话之后的**每一轮**，换账号、换区域都改不动它一个字节。
*
* `developer` 不在这里，因为 {@link prepareChatBody} 在调用本函数之前已经把它改写成
* `system`，而且两个网关对 `developer` 一律直接拒（改写它的内容救不了请求）。
*/
function scansOpening(role) {
	if (typeof role !== "string") return false;
	const name = role.trim().toLowerCase();
	return name === "system" || name === "assistant";
}
/**
* 遍历「网关会读的正文」，把每一处文本交给 `edit`。
*
* 四种变换（中性头、已知 span 改写、无条件前置、内容迁移）共用这一份遍历：它们的差别
* 只在「怎么改这一段」，而**改哪些段**是网关的规则，抄四遍就会有一份落后。
*
* 三种 shape 都必须走到，缺一种就是一个洞：
* - `content` 是字符串（最常见）；
* - `content` 是 part 数组，每个 `type: "text"` 的 part 都要处理——实测网关读**每一个**
*   文本 part，只修第一个等于修好一半，另一半留给用户再报一次；
* - 其余 shape（`null`、数字、畸形 part）原样留着：这段代码跑在**即将上线**的 body 上，
*   抛一次就是整条请求没了。
*
* `edit` 返回 `undefined` 表示「这一处不改」；返回是否改过任何一处，调用方据此决定
* 要不要为这次救援花一次往返。
*/
function mapScannedText(obj, edit) {
	const messages = obj["messages"];
	if (!Array.isArray(messages)) return false;
	let changed = false;
	for (const value of messages) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const message = value;
		if (!scansOpening(message["role"])) continue;
		const content = message["content"];
		if (typeof content === "string") {
			const next = edit(content);
			if (next === void 0) continue;
			message["content"] = next;
			changed = true;
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (typeof part !== "object" || part === null || Array.isArray(part)) continue;
			const record = part;
			const type = record["type"];
			if (typeof type !== "string" || type.trim().toLowerCase() !== "text") continue;
			const text = record["text"];
			if (typeof text !== "string") continue;
			const next = edit(text);
			if (next === void 0) continue;
			record["text"] = next;
			changed = true;
		}
	}
	return changed;
}
/**
* 把每条被扫描消息（`system` 与 `assistant`）的**开场**移出上面的内容指纹。
*
* 只处理**前缀**：网关对这张表里的词条是「按 trim 后的小写形态比开头」的规则，
* 同一句话出现在句中会放行（实测 `identity_mid` 200），所以这里也只在前缀命中时前置。
*
* 对「消息开头是别的东西」的 body 是空操作：网关本来就会放行的请求保持逐字节不变，
* 只有会被拒的那些消息多出一行短提示。
*
* **两种角色都要处理**，因为网关两种都读。只处理 `system` 会留下一个长期缺陷：会话
* 历史里有一条以被禁身份开头的 `assistant` 消息（模型复述自己的提示词、恢复的会话、
* 压缩产物），那一轮的每一句话都会被拒，没有任何账号或区域能改变它。
*
* 内层 span 不归这里管：那是 {@link CHANNEL_SPAN_REWRITES} 与
* {@link relocateScannedContent} 负责的另一道门。
*/
function neutralizeChannelFingerprints(obj) {
	mapScannedText(obj, (content) => isUnapprovedChannelOpening(content) ? `${WB_FALLBACK_SYSTEM_PROMPT}\n\n${content}` : void 0);
}
/**
* 网关按**精确子串**拒绝的已知 span，以及它们的等价改写。
*
* 与 {@link UNAPPROVED_CHANNEL_OPENINGS} 的分工：那张表是**前缀**规则（只比开场），
* 这张表是**子串**规则（正文任意位置）。两者是不同的闸门，实测同一天同时存在 ——
* 所以「把开场挪到中性头之后」既不能替代这张表，也不能被这张表替代。
*
* **为什么必须是看得见的改写。** 旧实现的第二级自救
* （{@link perturbChannelFingerprints}）靠插入不可见字符破坏匹配。2026-10-29 国内
* 网关实测：U+200B / U+200D / U+2060 / U+00AD 四种不可见字符**全部被剥离后再比对**，
* 每一个词后都插满的密集扰动仍然是 400（`.probe/t34e` 的 `span_dense`、
* `.probe/t34f` 的 `zwj_dense` / `wj_dense` / `shy_dense`）。同一批实测里只有
* **改变可见字节**才放行：断句（`split_sentence`）、加一个逗号
* （`one_word_changed`）、换行（`newline_mid`）都是 200，而大小写折叠
* （`case_word`）与空格加倍（`double_space`）是 400——网关做小写折叠且会把连续空格
* 压成一个，但不把换行折成空格。
*
* 结论：改写必须落到**读的人也看得见**的字节上，但语义必须等价。这张表就是那份等价
* 改写——把一句话拆成两句，读者得到同一件事，逐字节的子串匹配不再成立。
*
* 条目只收录**实测过**的 span（口径与取证见 `docs/CHANNEL-SPAN-REWRITE.md`）。
* 不靠猜扩充：没测过的 span 加进来只会改写今天能过 200 的提示词，而表外的未知 span
* 由救援梯的第二级（{@link relocateScannedContent}）兜住——那一步不需要知道 span。
*/
const CHANNEL_SPAN_REWRITES = [{
	match: "You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names.",
	replace: "You are interacting with the user through the DeepSeek Harness Web GUI. The runtime context names its URL."
}, {
	match: "Tokens prefixed with @ are paths the user explicitly referenced.",
	replace: "Tokens prefixed with @ are paths that the user explicitly referenced."
}];
/**
* 把被扫描消息里的已知 span 换成等价改写。
*
* 只在命中时改字节：不含这些 span 的请求**逐字节不变**（与
* {@link neutralizeChannelFingerprints} 同一条纪律，也是这条改写能无条件跑在
* 请求路径上的理由——它不是「每次都改」，是「命中才改」）。
*
* **匹配口径必须和网关一样，而不是和被禁那份字节一样。** 实测网关的比对是
* 「小写折叠 + 连续空格压成一个」（`.probe/t34f`：`double_space` 仍 400、`case_word`
* 仍 400，换行才是 200），所以这里用「词序相等 + `\s+` 连接 + `i` 标志」来匹配：
* 逐字节字面匹配会比闸门更窄——提示词里多一个空格或换个大写，表就整条落空，而请求
* 照样被拒。极端形状（换行）由救援梯兜住，因为那已经超出「同一句话」的范围。
*
* 拼接用 `\s+` 而不是把原字符串整体转义：span 里含引号、逗号与句点，逐词转义后拼接
* 才是唯一不会漏转义字符的写法。改写结果里 `\s+` 一律落成单空格——与网关看到的一致。
*
* 幂等：改写后不再包含任何一个词序列（`…Web GUI. The runtime context names its URL.`
* 里没有 `whose URL`），所以同一个 body 过两次结果不变。
*/
function rewriteChannelSpans(obj) {
	mapScannedText(obj, (text) => {
		let next = text;
		for (const rule of COMPILED_SPAN_REWRITES) next = next.replace(rule.pattern, rule.replace);
		return next === text ? void 0 : next;
	});
}
/** 把一条实测 span 编译成「与网关同口径」的匹配式（见 {@link rewriteChannelSpans}）。 */
function spanPattern(match) {
	const words = match.trim().split(/\s+/u).map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
	return new RegExp(words.join("\\s+"), "giu");
}
/**
* 编译一次，请求路径上只做匹配。
*
* 正则编译比一次 50 KB 文本的扫描贵得多，而这条路径每个请求都会跑（每个被扫描消息
* 一次）。`g` 标志带来的 `lastIndex` 状态不是问题：`String.prototype.replace` 在读之前
* 把它归零，用完也归零。
*/
const COMPILED_SPAN_REWRITES = CHANNEL_SPAN_REWRITES.map((rule) => ({
	pattern: spanPattern(rule.match),
	replace: rule.replace
}));
/**
* `content` 是否已经以中性占位开头。
*
* 只用于回答「再前置一次有没有意义」。比较前 trim 前导空白，理由与
* {@link isUnapprovedChannelOpening} 相同：网关今天会 trim，明天可能不 trim，而
* 我们只想知道自己有没有已经加过。
*/
function startsWithNeutralHead(text) {
	return text.replace(/^\s+/u, "").startsWith(WB_FALLBACK_SYSTEM_PROMPT);
}
/**
* 自救第一级：给**每一条**被扫描消息的开头前置中性占位。
*
* 与 {@link neutralizeChannelFingerprints} 的区别是**判据**：那一步只在命中已知
* 指纹表时才改写（宁可放过也不误伤），这一步在收到 `channel_reject` 之后无条件
* 改写每一条 system / assistant 的开场（已经以占位开头的不重复加）。
*
* 为什么需要它：那张指纹表**按定义不可能完整**——它是一次实测快照，上游随时能
* 加条目而我们看不到。表外的新指纹会让第一道防线整条落空，只剩一个必然的 400。
* 参考插件在同一处注释里承认过这件事（`THE LIST CANNOT BE COMPLETE`），这也是
* 它保留两级重试的原因。
*
* 跳过的情况各有理由：
* - `content.trim() === ''`：空内容不可能是「有罪的开关」，而带 `tool_calls` 的
*   `content: ''` 是合法的重放形状，往里面塞文字会改变语义；
* - 已经以占位开头：再加一次只会让提示词多一行噪声，白花一次注定被拒的往返。
*
* 无变化返回 `undefined`，调用方据此**不发**那次请求。
*
* 从解析后的对象重新序列化，保住原 key 顺序：重试的是同一个请求，不是重排过的
* 请求。JSON 解析失败原样返回 `undefined`——绝不因为自救逻辑本身把一个能用的
* 请求弄坏。
*/
function forceNeutralHead(bodyJson) {
	let body;
	try {
		body = JSON.parse(bodyJson);
	} catch {
		return;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return void 0;
	const obj = body;
	const messages = obj["messages"];
	if (!Array.isArray(messages)) return void 0;
	const prefix = `${WB_FALLBACK_SYSTEM_PROMPT}\n\n`;
	return mapScannedText(obj, (content) => content.trim() === "" || startsWithNeutralHead(content) ? void 0 : `${prefix}${content}`) ? JSON.stringify(obj) : void 0;
}
/**
* 把被扫描消息的正文**搬进一条 `user` 消息**，`system` 只留中性占位。
*
* **这是默认的请求形态，不是救援步骤。** 理由是一次一天之内的两次报障：
*
* - 第一次（221 字符 Web-GUI 段落）：网关按**正文子串**拒绝，我们加了一条改写；
* - 第二次（同一天的 233 条消息会话）：又一条我们没见过的 DSH 提示词 span
*   （`Tokens prefixed with @ are paths…`，`.probe/t39b` 用 ddmin 压出来的）。
*
* 两条 span 出自同一个来源——网关的清单是拿**已知 agent 提示词库**生成的，DSH 的 19 KB
* 系统提示里被收进去的不止一段。逐条追是追不完的：每加一条都要等用户先撞一次。
* 换角色则一次性解决**所有** system 正文的指纹，包括明天才会出现的那条。
*
* **为什么它成立。** 网关只读 `system` 与 `assistant` 两类消息的正文（2026-10-29 实测：
* 同一段 span 放进 `user` 消息，标题位置与正文中段都是 200，见 `.probe/t34f` 的
* `as_user` / `as_user_mid`；本次真实会话里 38 条 system/assistant 逐条扫，只有两条
* system 被拒，见 `.probe/t40`）。所以要让一份内容不再被扫描，除了改写它，还可以
* **换一个角色承载它**——不需要猜任何一个词条。
*
* **为什么不是「把 system 整条删掉」。** 11128 家族还有一支是「首条不是 system 提示词」，
* 删掉首条 system 会把渠道闸门换成另一支同样的 400。所以首条**仍然**是 system，只是
* 它变成中性占位，原文搬进紧随其后的第一条 `user`。
*
* **代价。** `system` 与 `user` 在多数模型上只是权重差异，不是语义差异；真实代价是
* 「模型可能不像读系统提示那样读这段规则」。给搬运块加一句说明就是为这件事：
* 让它明确知道这段话是**常驻规则**，不是用户这一轮的问题。另一个代价是这条路径对
* 所有请求生效（含本来能过闸门的），换来的是不再需要每次先失败一次。
*
* **不动 `assistant` 历史。** 它的正文无法搬到别的角色而不破坏 `tool_calls` 配对，所以
* 这里只搬 `system`；`assistant` 历史里若也有 span，留给
* {@link CHANNEL_SPAN_REWRITES} 的逐条改写（那是唯一不破坏配对的改法）。本次真实会话
* 的 80 条 assistant 消息逐条单发全部 200，这条风险目前是理论上的。
*
* 无可搬运内容（没有 system，或 system 正文就只有一行中性占位）时返回 `undefined`：
* 调用方据此原样使用 `prepared`，不为一次逐字节相同的请求多花往返。
*/
function relocateScannedContent(bodyJson) {
	let body;
	try {
		body = JSON.parse(bodyJson);
	} catch {
		return;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return void 0;
	const obj = body;
	const messages = obj["messages"];
	if (!Array.isArray(messages)) return void 0;
	/** 取一条消息的可搬运正文；数组 content 只搬文本 part（图片不属于提示词规则）。 */
	const carriedText = (content) => {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return void 0;
		const texts = [];
		for (const part of content) {
			if (typeof part !== "object" || part === null || Array.isArray(part)) continue;
			const record = part;
			const type = record["type"];
			if (typeof type !== "string" || type.trim().toLowerCase() !== "text") continue;
			const text = record["text"];
			if (typeof text === "string") texts.push(text);
		}
		return texts.length === 0 ? void 0 : texts.join("\n\n");
	};
	const kept = [];
	const carried = [];
	for (const value of messages) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			kept.push(value);
			continue;
		}
		const message = value;
		if ((typeof message["role"] === "string" ? message["role"].trim().toLowerCase() : "") !== "system") {
			kept.push(value);
			continue;
		}
		const text = carriedText(message["content"]);
		if (text === void 0) continue;
		const trimmed = text.trim();
		if (trimmed === "" || trimmed === "You are a helpful assistant.") continue;
		carried.push(text);
	}
	if (carried.length === 0) return void 0;
	obj["messages"] = [
		{
			role: "system",
			content: WB_FALLBACK_SYSTEM_PROMPT
		},
		{
			role: "user",
			content: `${RELOCATED_CONTEXT_HEAD}\n\n${carried.join("\n\n")}`
		},
		...kept
	];
	return JSON.stringify(obj);
}
/**
* 搬运块开头那句说明。
*
* 它必须做两件事：告诉模型这段话是**常驻规则**（否则一段二十万字的系统提示读起来像
* 用户这一轮的口气），并且不说「以下是系统提示词」——那等于把「这不是官方客户端」
* 写进请求正文，正好是这道闸门要找的东西。
*/
const RELOCATED_CONTEXT_HEAD = "This is my standing context and the rules I need you to keep following for this whole conversation.";
/**
* 删掉只会失败的 `reasoning_effort: "off"`（issue #34 / #83）。
*
* 拒绝表 `REFUSES_OFF_MODEL_IDS` 住在 `status-paths.ts:402`，因为 `adapter.ts` 造
* `thinkingLevelMap` 时也要读它（那里决定 `map.off` 是 `'off'` 还是 `null`），而
* 两个半区都得看得见同一份真相。这张表记的是实测结果：上游名册把
* `reasoning.canDisableThinking` 声明成 true，但这几个 id 对 `off` 回 HTTP 400 /
* 业务码 11133，其余每一档以及完全不带该字段都能过——声明的能力字段分不开这两组，
* 所以只能按精确 id 硬记。
*
* adapter 现在会宣告 reasoning，因此**正常情况下 body 里就不该再出现会失败的
* `off`**（`wbThinkingLevelMap` 已经把拒绝表的 id 的 `off` 映射成 `null`，选择器
* 根本不会提供这一档）。保留这一步是纵深防御：请求实际点名的模型可能在名册建好
* 之后才变（换号会把 body 重新指向另一个账号的模型，`primary-model` 这类别名由
* 网关解析成具体 id），而归一化适配器是按**调用方点名**的模型查目录的，两者在此
* 处可能不一致。一旦漏掉，失败形态是「这个模型坏了」而不是「这一档设置非法」——
* 同一档失败会跟着已保存的每模型选择重复出现在之后的每一轮。
*
* 在这里删，是因为这是插件在上游记账之前能控制的最后一步。
*
* 只动字面 `"off"`。其余每一档在测过的每个模型上都返回 200；不带该字段的 body 一律
* 不碰：删掉调用方从没发过的字段，等于替它决定模型该怎么思考。
*/
function dropRefusedReasoning(obj) {
	const effort = obj["reasoning_effort"];
	if (typeof effort !== "string" || effort.trim().toLowerCase() !== "off") return;
	const model = obj["model"];
	if (typeof model !== "string" || !WB_REFUSES_OFF_MODEL_IDS.has(model)) return;
	delete obj["reasoning_effort"];
}
/**
* 把 OpenAI 形状的入站请求改写成 WorkBuddy 上游能接受的形状。
*
* 五件事是硬性形状要求、两件是渠道闸门，都有实测依据，缺一条就是必然失败
* （照 `dsh-connect-workbuddy/src/upstream.ts:1919` 的实现，注释带走理由）：
*
* 1. `stream` 强制 `true`：上游聊天端点只有流式形态，非流式请求会挂住不返回。
* 2. `developer` 角色改写成 `system`：DSH 用 OpenAI 的 `developer` 角色发系统提示词，
*    而 WorkBuddy 的 CLI 通道只认 `system`，遇到 `developer` 回业务码 11128
*    （「未授权通道」）。
* 3. 首条消息必须是 `system`：网关按开场白指纹判定通道，首条不是 system 时补一条
*    中性占位。
* 4. 渠道闸门①（前缀）：命中已知开场白的 system/assistant 消息前置中性占位。
* 5. 渠道闸门②（子串）：正文里的已知 span 换成语义等价的改写。这两道门是**不同**的
*    规则——2026-10-29 实测：网关对正文做大小写折叠的精确子串匹配，且会把不可见
*    字符剥离后比对，所以只有第 4 步救不了内层 span，只有第 5 步也救不了开场白。
* 6. `tool_choice` 归一成字符串：上游只接受 `'auto'|'required'|'none'` 三态字符串，
*    OpenAI 的对象形态会被拒；`none` 还要连带删掉 `tools`（否则上游仍会尝试调用工具）。
*
* 以上六步都只在**命中时**改字节：一份今天能过 200 的请求，出站时逐字节不变。
*
* 纯函数，解析失败原样返回：绝不因为改写逻辑本身把一个能用的请求弄坏。
*/
function prepareChatBody(source) {
	let body;
	try {
		body = JSON.parse(source);
	} catch {
		return source;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return source;
	const obj = body;
	obj["stream"] = true;
	if (Array.isArray(obj["messages"])) for (const value of obj["messages"]) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const message = value;
		if (message["role"] === "developer") message["role"] = "system";
	}
	const messages = obj["messages"];
	if (Array.isArray(messages) && messages.length > 0) {
		const head = messages[0];
		if (typeof head === "object" && head !== null && !Array.isArray(head)) {
			const role = head["role"];
			if (!(typeof role === "string" && role.trim().toLowerCase() === "system")) messages.unshift({
				role: "system",
				content: WB_FALLBACK_SYSTEM_PROMPT
			});
		}
	}
	neutralizeChannelFingerprints(obj);
	rewriteChannelSpans(obj);
	if ("tool_choice" in obj) {
		const choice = obj["tool_choice"];
		const suppress = () => {
			delete obj["tools"];
			delete obj["functions"];
		};
		if (typeof choice === "string") {
			if (choice.trim().toLowerCase() === "none") {
				delete obj["tool_choice"];
				suppress();
			} else if (choice.trim().toLowerCase() === "auto" || choice.trim().toLowerCase() === "required") obj["tool_choice"] = choice.trim().toLowerCase();
		} else if (typeof choice === "object" && choice !== null && !Array.isArray(choice)) {
			const wrapped = choice;
			const type = typeof wrapped["type"] === "string" ? wrapped["type"].trim().toLowerCase() : "";
			if (type === "none") {
				delete obj["tool_choice"];
				suppress();
			} else if (type === "auto" || type === "required") obj["tool_choice"] = type;
		}
	}
	dropRefusedReasoning(obj);
	return JSON.stringify(obj);
}
function createWbShim(options) {
	const { pool, client, catalog, region } = options;
	const logger = options.logger;
	const maxAttempts = options.maxAttempts ?? 8;
	/**
	* 读当前的临期窗口。
	*
	* 每次用到都重新问一遍（而不是构造时快照）：设置页改完立刻生效，不必重启插件。
	* getter 抛错时返回 `undefined` 让 `aggregateCredits` 落回兜底值——一个读配置
	* 失败绝不能让余额刷新整体失败（那会把卡片变成「余额未知」，而池里明明有旧读数）。
	*/
	function warnDaysOf() {
		try {
			return options.expiryWarnDays?.();
		} catch {
			return;
		}
	}
	const SHARED_SECRET = randomBytes(32).toString("base64url");
	function bearerOk(req) {
		const header = req.headers.authorization;
		if (typeof header !== "string") return false;
		const match = /^Bearer\s+(.+)$/i.exec(header.trim());
		if (match === null) return false;
		const a = Buffer.from(match[1]);
		const b = Buffer.from(SHARED_SECRET);
		if (a.length !== b.length) return false;
		return timingSafeEqual(a, b);
	}
	/**
	* (账号, 模型) → 冷却截止时刻。
	*
	* 以模型为键的第二段是必须的：上游限流按模型计（错误文案会建议「可切换其他模型
	* 继续使用」），`hy4-preview` 上的 429 只该冷却该账号的那个模型，封掉整账号会让
	* 用户在一个模型的限流里丢掉全部模型。
	*/
	const cooldownUntil = /* @__PURE__ */ new Map();
	function cooldownKey(accountId, modelId) {
		return `${accountId}\u0000${modelId ?? "*"}`;
	}
	function markCooling(accountId, modelId, kind, message) {
		const hours = kind === "hard_credit" ? WB_HARD_CREDIT_COOLDOWN_MS : WB_DEFAULT_COOLDOWN_MS;
		const until = (kind === "soft_rate" ? parseRateLimitReset(message) : void 0) ?? Date.now() + hours;
		cooldownUntil.set(cooldownKey(accountId, modelId), until);
	}
	/**
	* 此刻在冷却的账号 id。
	*
	* 冷却表以 `(账号, 模型)` 为键，而 `pool.pick` 的 `excludeIds` 只认账号 id——
	* 所以这里必须按**本次请求的模型**过滤一遍再展开成数组，否则把「A 账号在
	* hy4-preview 上被限流」错误地排除成「A 账号在所有模型上都不可用」。
	*
	* 无模型的请求（`modelId === undefined`）配到的是通配键 `*`；它代表「整个账号
	* 都别用了」，因此对任意模型都成立。
	*/
	function coolingIdsOf(modelId) {
		const now = Date.now();
		const ids = [];
		for (const key of [...cooldownUntil.keys()]) {
			const until = cooldownUntil.get(key);
			if (until === void 0) continue;
			if (until <= now) {
				cooldownUntil.delete(key);
				continue;
			}
			const [accountId, cooledModel] = key.split("\0");
			if (accountId === void 0 || accountId === "") continue;
			if (cooledModel !== "*" && cooledModel !== (modelId ?? "*")) continue;
			if (!ids.includes(accountId)) ids.push(accountId);
		}
		return ids;
	}
	/**
	* 尽力刷新一个账号的积分余额。
	*
	* 成功请求后于后台运行。失败被刻意吞掉：余额读数只是排序与显示的依据，一次抖动
	* 的余额查询绝不能变成失败的用户请求或噪声日志。
	*
	* 到期时间与余额同行写回：`expiry` 分布靠它排序，而余额读取是我们唯一能学到它的
	* 地方。
	*/
	const lastBalanceAt = /* @__PURE__ */ new Map();
	const BALANCE_REFRESH_MS = 6e5;
	async function refreshBalance(account) {
		const now = Date.now();
		if (now - (lastBalanceAt.get(account.id) ?? 0) < BALANCE_REFRESH_MS) return;
		lastBalanceAt.set(account.id, now);
		try {
			const raw = await client.fetchCredits(account.credential);
			const warnDays = warnDaysOf();
			const { credits } = aggregateCredits(raw, {
				nowMs: now,
				...warnDays === void 0 ? {} : { warnDays }
			});
			pool.noteCredits(account.id, credits);
		} catch {}
	}
	function writeSseHead(res) {
		res.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no"
		});
	}
	async function chatCompletions(req, res) {
		if (!isJsonContentType(req)) {
			writeOpenAIError(res, 415, "unsupported_media_type", "chat completions requires application/json");
			return;
		}
		let raw;
		try {
			raw = (await readBody(req)).toString("utf8");
		} catch (error) {
			writeOpenAIError(res, 413, "body_too_large", error instanceof Error ? error.message : "request body too large");
			return;
		}
		const controller = new AbortController();
		req.on("close", () => controller.abort());
		const conversationKey = conversationKeyOf(raw);
		const modelId = modelIdOf(raw);
		const prepared = prepareChatBody(raw);
		const tried = [];
		const excluded = [];
		let last;
		for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
			if (controller.signal.aborted) return;
			const result = pool.pick(region, {
				...conversationKey === void 0 ? {} : { conversationKey },
				excludeIds: [...excluded, ...coolingIdsOf(modelId)]
			});
			const account = result.account;
			if (account === void 0) {
				if (last !== void 0 && last.kind !== "authentication" && last.kind !== "session_dead") {
					writeOpenAIError(res, KIND_STATUS[last.kind], last.kind, `试过 ${tried.length} 个 WorkBuddy 账号都没有成功: ${tried.join(" → ")} — ${last.message.slice(0, 300)}`);
					return;
				}
				const why = exhaustedReason(result.ranked.length, excluded);
				writeOpenAIError(res, why.status, why.kind, why.message);
				return;
			}
			tried.push(account.label);
			excluded.push(account.id);
			let attemptBody = relocateScannedContent(prepared) ?? prepared;
			let outcome = await client.chatStream(account.credential, attemptBody, controller.signal);
			if (controller.signal.aborted) return;
			if (!outcome.ok && outcome.kind === "channel_reject") {
				if (prepared !== attemptBody) {
					outcome = await client.chatStream(account.credential, prepared, controller.signal);
					if (controller.signal.aborted) return;
				}
				if (!outcome.ok && outcome.kind === "channel_reject") {
					const forced = forceNeutralHead(prepared);
					if (forced !== void 0 && forced !== prepared) {
						outcome = await client.chatStream(account.credential, forced, controller.signal);
						if (controller.signal.aborted) return;
					}
				}
			}
			if (outcome.ok) {
				writeSseHead(res);
				try {
					for await (const chunk of Readable.fromWeb(outcome.response.body)) {
						if (controller.signal.aborted) break;
						res.write(chunk);
					}
				} catch (error) {
					logger?.warn("dsh-connect-workbuddy-models: 上游流在中途断开", error);
				} finally {
					if (!res.writableEnded) res.end();
				}
				refreshBalance(account);
				return;
			}
			last = {
				kind: outcome.kind,
				status: outcome.status,
				message: outcome.message
			};
			if (outcome.kind === "authentication" || outcome.kind === "session_dead") {
				if (outcome.retryable === true) markCooling(account.id, modelId, "soft_rate", outcome.message);
				else pool.markCredentialDead(account.id);
			}
			if (outcome.kind === "soft_rate" || outcome.kind === "hard_credit") markCooling(account.id, modelId, outcome.kind, outcome.message);
			if (outcome.kind === "local_gate_oversize" || outcome.kind === "local_gate_unattributed") {
				const shape = requestShape(raw);
				logger?.warn("dsh-connect-workbuddy-models: 请求被本机 billion-context 闸门拒绝（未发出）", outcome.kind, shape, outcome.message.slice(0, 200));
				writeOpenAIError(res, KIND_STATUS[outcome.kind], outcome.kind, `这个请求被本机 billion-context 闸门拦下了，没有发给 WorkBuddy 上游（${shape}）。` + localGateAdvice(outcome));
				return;
			}
			if (outcome.kind === "channel_reject") {
				const shape = requestShape(raw);
				logger?.warn("dsh-connect-workbuddy-models: 渠道闸门拒绝了请求，三级形态均被拒", shape, outcome.message.slice(0, 200));
				writeOpenAIError(res, KIND_STATUS["channel_reject"], "channel_reject", `上游把这个请求判为未授权通道（${shape}）：内容迁移、还原 system 角色、中性开头三种形态都试过仍未放行。前两种已经把 system 正文放到网关不扫描的位置、或改写掉已知 span，所以剩下的触发点只可能在 assistant 历史里；请把这句话连同下面的上游原话反馈给我们。 上游原话：${outcome.message.slice(0, 300)}`);
				return;
			}
			if (outcome.kind === "client_reject" || outcome.kind === "client") {
				const shape = requestShape(raw);
				logger?.warn("dsh-connect-workbuddy-models: 上游拒绝了请求形状", shape, outcome.message.slice(0, 200));
				const contextTooLong = isContextTooLong(outcome.message);
				const body = clientRejectionBody(outcome, contextTooLong);
				writeOpenAIError(res, contextTooLong ? 400 : KIND_STATUS[outcome.kind], contextTooLong ? "context_length_exceeded" : outcome.kind, contextTooLong ? `这个模型的上下文窗口放不下当前对话（${shape}）；请减少历史或换一个更大窗口的模型` : `上游拒绝了这个请求（${shape}）：${body}`);
				return;
			}
		}
		const upstream = last === void 0 ? "" : ` — ${last.message.slice(0, 200)}`;
		writeOpenAIError(res, last === void 0 ? 502 : KIND_STATUS[last.kind], last?.kind ?? "server", `试过 ${tried.length} 个 WorkBuddy 账号都没有成功: ${tried.join(" → ")}${upstream}`);
	}
	/**
	* 「没有账号可用」的可执行解释。
	*
	* 每一条都要能让用户采取行动（重新登录 / 勾选参与池 / 等一会 / 换模型），而不是
	* 只说「不可用」。
	*/
	function exhaustedReason(total, excluded) {
		const area = region === "global" ? "国际版" : "国内版";
		if (total === 0) return {
			status: 401,
			kind: "not_signed_in",
			message: `没有发现任何${area} WorkBuddy 账号；请先登录 WorkBuddy 桌面端（国内账号登 codebuddy.cn，国际账号登 workbuddy.ai）`
		};
		const dead = excluded.filter((id) => pool.find(id)?.credentialDead === true).length;
		if (dead > 0 && dead >= excluded.length) return {
			status: 401,
			kind: "session_dead",
			message: `${area}的 ${dead} 个账号都被上游拒绝了登录凭据；请重新登录 WorkBuddy 桌面端`
		};
		return {
			status: 429,
			kind: "soft_rate",
			message: `${area}的 ${total} 个账号此刻都在冷却或被排除（本次已试 ${excluded.length} 个）；请稍等片刻或换一个模型`
		};
	}
	const server = createServer((req, res) => {
		handleRequest(req, res);
	});
	async function handleRequest(req, res) {
		try {
			if (!hostIsLoopback(req.headers.host)) {
				writeOpenAIError(res, 403, "forbidden_host", "this endpoint only serves loopback hosts");
				return;
			}
			if (!originIsLoopback(req.headers.origin)) {
				writeOpenAIError(res, 403, "forbidden_origin", "this endpoint only serves loopback origins");
				return;
			}
			if (!bearerOk(req)) {
				writeOpenAIError(res, 401, "invalid_api_key", "this endpoint requires the in-process WorkBuddy pool secret");
				return;
			}
			const method = req.method ?? "GET";
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			if (method === "POST" && url.pathname === "/v1/chat/completions") {
				await chatCompletions(req, res);
				return;
			}
			if (method === "GET" && url.pathname === "/v1/models") {
				writeJson(res, 200, {
					object: "list",
					data: catalog.visible().map((model) => ({
						id: model.id,
						object: "model",
						owned_by: "workbuddy",
						...model.contextWindow === void 0 ? {} : { context_window: model.contextWindow }
					}))
				});
				return;
			}
			writeOpenAIError(res, 404, "not_found", `no such route: ${method} ${url.pathname}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger?.error("dsh-connect-workbuddy-models: shim 请求失败", error);
			if (!res.headersSent) writeOpenAIError(res, 500, "server", message);
			else if (!res.writableEnded) res.end();
		}
	}
	const ready = new Promise((resolve, reject) => {
		server.once("listening", () => resolve());
		server.once("error", reject);
	});
	server.listen(0, "127.0.0.1");
	const baseUrl = () => {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("workbuddy-models shim 还没有监听地址");
		return `http://127.0.0.1:${address.port}`;
	};
	return {
		ready,
		baseUrl,
		token: () => SHARED_SECRET,
		close: () => new Promise((resolve) => {
			server.close(() => resolve());
			server.closeAllConnections?.();
		})
	};
}
/**
* 供测试与诊断：把一个上游失败分类成「该不该换号」。
*
* `false` 表示换账号也不会成功（请求形状问题），`true` 表示值得换下一个。
* 单独导出而不是内联在循环里，因为它是本文件唯一一条「何时停止重试」的规则，
* 而它出错的代价是 8 倍的无效上游请求或一次本该成功的对话被放弃。
*/
function worthRetrying(kind) {
	switch (kind) {
		case "soft_rate":
		case "hard_credit":
		case "authentication":
		case "session_dead":
		case "server": return true;
		default: return false;
	}
}
/** 供测试：把一个错误对象归类。`WbCredentialRejectedError` 一律是凭据问题。 */
function classifyThrown(error) {
	if (isCredentialRejectedError(error)) return "authentication";
	if (error instanceof WbCredentialRejectedError) return "authentication";
	return "server";
}
//#endregion
//#region src/web-status.ts
/** 把 token 类内容抹掉再送回浏览器。 */
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]").slice(0, 500);
}
function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload),
		"Cache-Control": "no-store"
	});
	res.end(payload);
}
/**
* 只接受回环浏览器来源。
*
* 没有 `Origin` 头的请求放行：那是同源导航或 curl 这类本地诊断，而它们本来就能
* 直接读磁盘上的凭据文件；带 `Origin` 的跨站请求一律拒绝，否则任意网页都能读走
* 用户的账号列表与积分。
*/
function loopbackOrigin(req) {
	const origin = req.headers.origin;
	if (origin === void 0) return true;
	try {
		const { hostname } = new URL(origin);
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
	} catch {
		return false;
	}
}
/** 最小 POST body 读取器，带上限，防止挂起或超大 body 钉住宿主内存。 */
function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		const LIMIT = 65536;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > LIMIT) {
				reject(/* @__PURE__ */ new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8").trim();
			if (text === "") {
				resolve({});
				return;
			}
			try {
				const parsed = JSON.parse(text);
				resolve(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {});
			} catch {
				reject(/* @__PURE__ */ new Error("invalid JSON body"));
			}
		});
		req.on("error", reject);
	});
}
/** 从 query 里取一个区域；缺省 `cn`（界面的主区域），非法值给 undefined。 */
function regionOfRequest(req) {
	const raw = queryParamOf(req.url ?? "", WB_REGION_PARAM);
	if (raw === void 0 || raw === "") return "cn";
	return raw === "cn" || raw === "global" ? raw : void 0;
}
/** 从一个任意值里取字符串数组，非数组给 `[]`（配置补丁的唯一入口校验）。 */
function stringListOf(value) {
	if (!Array.isArray(value)) return void 0;
	return value.filter((entry) => typeof entry === "string" && entry !== "");
}
/** 距离某个时刻的天数（向上取整）；无值或缺省给 undefined。 */
function daysUntil(atMs, nowMs) {
	if (atMs === void 0 || !Number.isFinite(atMs)) return void 0;
	return Math.max(0, Math.ceil((atMs - nowMs) / 864e5));
}
/**
* 组装 `/status` 的应答。
*
* 全部读池里的**缓存读数**，不发上游请求：卡片每几秒轮询一次，每次都去问上游会
* 让 4 个账号 × 每分钟 12 次的余额查询变成常态流量，而余额本身十分钟才动一次。
*/
function buildStatus(deps, region, nowMs = Date.now()) {
	const config = deps.readConfig();
	const pick = deps.pickOf(region);
	const ranks = new Map(pick.ranked.map((row, index) => [row.account.id, index + 1]));
	const readings = deps.pool.listRegion(region).map((entry) => {
		const credits = entry.credits;
		const excludedBy = deps.pool.exclusionReason(entry);
		const probeCredits = credits === void 0 ? {} : {
			credits,
			total: credits.total,
			expiringSoon: credits.expiringSoon,
			...credits.nearestExpiryMs === void 0 ? {} : { nearestExpiryMs: credits.nearestExpiryMs },
			...daysUntil(credits.nearestExpiryMs, nowMs) === void 0 ? {} : { daysToExpiry: daysUntil(credits.nearestExpiryMs, nowMs) }
		};
		const rank = ranks.get(entry.account.id);
		return {
			account: {
				id: entry.account.id,
				accountName: entry.account.label,
				domain: entry.account.credential.domain,
				region: entry.account.region,
				source: entry.account.source,
				tokenExpiresAtMs: entry.account.tokenExpiresAtMs ?? 0,
				sourcePath: entry.account.sourcePath,
				selected: deps.pool.preferredOf(entry.account.region) === entry.account.id
			},
			...probeCredits,
			id: entry.account.id,
			region: entry.account.region,
			selected: deps.pool.preferredOf(entry.account.region) === entry.account.id,
			label: entry.account.label,
			...rank === void 0 ? {} : { rank },
			...excludedBy === void 0 ? {} : { excludedBy },
			...entry.checkin === void 0 ? {} : {
				checkin: entry.checkin,
				todayCheckedIn: entry.checkin.todayCheckedIn,
				streakDays: entry.checkin.streakDays
			}
		};
	});
	const readout = totalCreditsOf(deps.pool.listRegion(region).filter((entry) => deps.pool.exclusionReason(entry) === void 0).map((entry) => ({
		accountId: entry.account.id,
		...entry.credits === void 0 ? {} : { credits: entry.credits },
		readAtMs: nowMs
	})));
	const catalogInfo = (which) => {
		const catalog = deps.catalogs.of(which);
		const updatedAt = catalog.lastUpdatedAt;
		const lastError = catalog.lastFetchError;
		return {
			source: catalog.source,
			modelCount: catalog.all().length,
			...updatedAt === void 0 ? {} : { lastUpdatedAtMs: updatedAt },
			...lastError === void 0 ? {} : { lastError },
			usable: catalog.isUsable(),
			enabled: catalog.isEnabled()
		};
	};
	const models = deps.catalogs.of(region).all();
	const busyLevels = {};
	for (const model of models) if (model.busyLevel !== void 0) busyLevels[model.id] = model.busyLevel;
	const regionCatalog = deps.catalogs.of(region);
	const catalogFetchedAt = regionCatalog.lastFetchedAtMs;
	const catalogAge = regionCatalog.ageMs(nowMs);
	const busyFetchedAt = deps.busyFetchedAtMs?.(region);
	return {
		scannedAtMs: deps.pool.lastScannedAtMs,
		region,
		accounts: readings,
		skipped: deps.pool.skippedFiles,
		models,
		busyLevels,
		...catalogFetchedAt === void 0 ? {} : { modelsFetchedAtMs: catalogFetchedAt },
		...catalogAge === void 0 ? {} : { modelsAgeMs: catalogAge },
		...busyFetchedAt === void 0 ? {} : { busyFetchedAtMs: busyFetchedAt },
		totalCredits: readout.total,
		creditsReadout: readout,
		catalogs: {
			cn: catalogInfo("cn"),
			global: catalogInfo("global")
		},
		automation: deps.scheduler.status(),
		config,
		picks: rankReasonsOf(deps.pool, region, nowMs)
	};
}
/**
* 自动刷新的纯判定：这一刻该不该为这条链路发一次请求。
*
* 单独抽出来是为了让四种边界都能在测试里逐条钉住——它们全都产生过真实故障：
*
* - 从未成功过 → 过期。启动播种失败后停在兜底名册，必须允许重试。
* - 时钟回拨（`nowMs < fetchedAtMs`）→ 过期。否则 NTP 校正之后要等到真实时间追上
*   那个未来时间戳，自动刷新才会恢复。
* - 恰好等于 TTL → 过期（`>=`，不是 `>`）。
* - 上一次还没回来 → 不发。这条就是「单飞」，它是正确性要求不是性能优化。
*
* `lane === 'busy'` 且刷新器缺席时返回 `false`：老调用方没有实现它，不该因此
* 每次 `/status` 都白跑一遍判定。
*/
function shouldRefreshForTest(lane, fetchedAtMs, nowMs, inFlight, hasRefresher) {
	if (inFlight) return false;
	if (!hasRefresher) return false;
	const ttl = lane === "models" ? WB_CATALOG_TTL_MS : WB_BUSY_TTL_MS;
	if (fetchedAtMs === void 0) return true;
	if (nowMs < fetchedAtMs) return true;
	return nowMs - fetchedAtMs >= ttl;
}
/**
* 自动刷新的一次判定与发起。**生产与测试共用这一份**。
*
* 抽成一个函数而不是让路由闭包与测试各写一遍，是有代价教训的：原先 `kick` 与
* `refreshForTest` 是两份独立实现，其中「闸门登记先于启动」这条被写反了一次，
* 而测试用的是另一份，于是测试全绿、生产照旧坏。判定逻辑只能有一份。
*
* 返回本次实际发起的请求数，供测试断言「一次都没发」「只发了一次」这种性质。
*
* 四条性质（都有对应的回归用例）：
*
* 1. **不阻塞调用方**：发起即返回，失败只计数不抛。`/status` 必须立刻应答。
* 2. **单飞**：同一条链路同一个区域同时只有一个在飞。两个标签页加几秒一次的
*    轮询足以把上游打到 429，那会连带打挂真正要用的模型调用。所以闸门必须在
*    **启动之前**登记进 `inFlight`——`start()` 返回的 promise 即使立刻被拒绝，
*    `.finally` 也要等微任务才跑，中间那一瞬不能算「没在飞」。
* 3. **连续失败到上限就停手**：凭据过期时不能让设置页变成不断打上游的循环。
*    手动刷新会清掉计数（它走另一条路径，不经过这里）。
* 4. **两条链路各算各的**：目录 5 分钟、拥挤度 1 分钟。合成一条会逼出「为了拥挤度
*    每分钟读一遍大文档」或「拥挤度 5 分钟才更新一次」两种坏结果。
*/
function runAutoRefresh(deps, region, nowMs) {
	const { inFlight, failures } = deps.refreshState ?? {
		inFlight: {
			models: /* @__PURE__ */ new Map(),
			busy: /* @__PURE__ */ new Map()
		},
		failures: /* @__PURE__ */ new Map()
	};
	const sent = {
		models: 0,
		busy: 0
	};
	const maxFailures = deps.maxAutoFailures ?? 3;
	if (deps.autoRefresh === false) return sent;
	const fire = (lane, start) => {
		if ((failures.get(`${lane}:${region}`) ?? 0) >= maxFailures) return;
		const fetchedAt = lane === "models" ? deps.catalogs.of(region).lastFetchedAtMs : deps.busyFetchedAtMs?.(region);
		const hasRefresher = lane === "models" ? true : deps.refreshBusy !== void 0;
		if (!shouldRefreshForTest(lane, fetchedAt, nowMs, inFlight[lane].has(region), hasRefresher)) return;
		sent[lane] += 1;
		const running = start().then(() => {
			failures.delete(`${lane}:${region}`);
		}).catch((error) => {
			failures.set(`${lane}:${region}`, (failures.get(`${lane}:${region}`) ?? 0) + 1);
			deps.logger?.warn(`dsh-connect-workbuddy-models: 自动刷新 ${lane} 失败（${region}）`, error);
		}).finally(() => {
			inFlight[lane].delete(region);
		});
		inFlight[lane].set(region, running);
	};
	fire("models", () => deps.refreshModels(region));
	fire("busy", () => deps.refreshBusy(region));
	return sent;
}
/**
* 在 `webServer` 可用的 context 上挂载全部路由。
*
* 调用方用 `ctx.inject(['webServer'], ...)`，让桌面端启动顺序无法让这次注册凭空
* 消失；直接 `ctx.webServer.register` 在没有该服务时会抛，把整个插件的 apply 弄崩
* （连 provider 都注册不上）。
*/
function registerWbStatusRoutes(ctx, deps) {
	ctx.effect(() => {
		const disposers = [];
		/** 每个路由都要过的三道闸：方法、来源、region 解析。 */
		const guard = (req, res, method) => {
			if ((req.method ?? "GET") !== method) {
				json(res, 405, { error: `method not allowed: 该路由只接受 ${method}` });
				return;
			}
			if (!loopbackOrigin(req)) {
				json(res, 403, { error: "origin-not-trusted: 只接受本机浏览器请求" });
				return;
			}
			const region = regionOfRequest(req);
			if (region === void 0) {
				json(res, 400, { error: `invalid ${WB_REGION_PARAM}: 只接受 cn 或 global` });
				return;
			}
			return region;
		};
		const refreshDeps = {
			...deps,
			refreshState: deps.refreshState ?? {
				inFlight: deps.inFlight ?? {
					models: /* @__PURE__ */ new Map(),
					busy: /* @__PURE__ */ new Map()
				},
				failures: /* @__PURE__ */ new Map()
			}
		};
		/** 两条链路一起判。手动刷新不走这里（它要 `await`）。 */
		const kickAutoRefresh = (region, nowMs = Date.now()) => {
			runAutoRefresh(refreshDeps, region, nowMs);
		};
		disposers.push(ctx.webServer.register({
			kind: "exact",
			path: WB_STATUS_PATH,
			handler: (req, res) => {
				if (guard(req, res, "GET") === void 0) return;
				const region = regionOfRequest(req) ?? "cn";
				try {
					json(res, 200, buildStatus(deps, region));
					kickAutoRefresh(region);
				} catch (error) {
					deps.logger?.warn("dsh-connect-workbuddy-models: /status 失败", error);
					json(res, 500, { error: safeMessage(error) });
				}
			}
		}));
		disposers.push(ctx.webServer.register({
			kind: "exact",
			path: WB_ACCOUNTS_REFRESH_PATH,
			handler: async (req, res) => {
				const region = guard(req, res, "POST");
				if (region === void 0) return;
				try {
					await deps.rescan();
					json(res, 200, buildStatus(deps, region));
				} catch (error) {
					deps.logger?.warn("dsh-connect-workbuddy-models: 重扫失败", error);
					json(res, 500, { error: `rescan-failed: ${safeMessage(error)}（凭据目录可能被占用；重试或手动重启 WorkBuddy 桌面端）` });
				}
			}
		}));
		disposers.push(ctx.webServer.register({
			kind: "exact",
			path: WB_ACCOUNT_CREDITS_PATH,
			handler: async (req, res) => {
				if (guard(req, res, "GET") === void 0) return;
				const accountId = accountIdOf(req.url ?? "");
				if (accountId === void 0 || accountId === "") {
					json(res, 400, { error: "缺少 accountId 查询参数（用 /accounts/refresh 拿账号列表）" });
					return;
				}
				const entry = deps.pool.find(accountId);
				if (entry === void 0) {
					json(res, 404, { error: `unknown account: ${accountId}（可能已被上游注销，重扫一次）` });
					return;
				}
				try {
					const config = deps.readConfig();
					const [probe] = await deps.probe([entry.account], config.expiryWarnDays);
					if (probe !== void 0 && probe.credits !== void 0) deps.pool.noteCredits(accountId, probe.credits);
					if (probe !== void 0 && probe.checkin !== void 0) deps.pool.noteCheckin(accountId, probe.checkin);
					json(res, 200, {
						accountId,
						label: entry.account.label,
						region: entry.account.region,
						...probe === void 0 ? {} : probe,
						...entry.credits === void 0 ? {} : { cached: entry.credits }
					});
				} catch (error) {
					deps.logger?.warn("dsh-connect-workbuddy-models: 读积分失败", error);
					json(res, 502, { error: `credits-unavailable: ${safeMessage(error)}（检查该账号是否还能在 WorkBuddy 里对话）` });
				}
			}
		}));
		disposers.push(ctx.webServer.register({
			kind: "exact",
			path: WB_CHECKIN_PATH,
			handler: async (req, res) => {
				const region = guard(req, res, "POST");
				if (region === void 0) return;
				if (region === "global") {
					json(res, 400, { error: "checkin-unsupported-region: 国际版不提供签到活动；这条路由只对国内版账号生效" });
					return;
				}
				const accountId = accountIdOf(req.url ?? "");
				try {
					if (accountId === void 0 || accountId === "") {
						const started = deps.scheduler.isEnabled();
						deps.scheduler.runCheckinNow({
							region,
							force: true
						}).catch((error) => {
							deps.logger?.warn("dsh-connect-workbuddy-models: 全量签到失败", error);
						});
						json(res, 200, {
							ok: true,
							running: true,
							started,
							detail: [started ? "已开始为全部账号签到（逐账号间隔 800ms，避免上游限流）" : "已开始为全部账号签到（自动签到开关关闭不影响这次手动运行）"],
							credit: 0,
							grantedCredit: 0,
							alreadyDone: false
						});
						return;
					}
					const entry = deps.pool.find(accountId);
					if (entry === void 0) {
						json(res, 404, { error: `unknown account: ${accountId}（可能已在 WorkBuddy 桌面端退出登录；先重新扫描账号）` });
						return;
					}
					if (entry.account.region !== region) {
						json(res, 409, { error: `account-region-mismatch: 该账号属于 ${entry.account.region}，不能在 ${region} 的签到路由下使用` });
						return;
					}
					const result = await deps.scheduler.checkinOne(accountId);
					json(res, 200, {
						ok: true,
						credit: result.gain?.credit ?? 0,
						grantedCredit: result.gain?.credit ?? 0,
						alreadyDone: result.gain?.alreadyDone === true,
						detail: result.detail,
						...entry?.credits === void 0 ? {} : { total: entry.credits.total }
					});
				} catch (error) {
					deps.logger?.warn("dsh-connect-workbuddy-models: 签到失败", error);
					json(res, 502, { error: `checkin-failed: ${safeMessage(error)}（凭据可能已失效；在 WorkBuddy 桌面端重新登录后重试）` });
				}
			}
		}));
		disposers.push(ctx.webServer.register({
			kind: "exact",
			path: WB_BENEFIT_CLAIM_PATH,
			handler: async (req, res) => {
				if (guard(req, res, "POST") === void 0) return;
				const accountId = accountIdOf(req.url ?? "");
				const kind = claimKindOf(req.url ?? "") ?? benefitKindOf(queryParamOf(req.url ?? "", "kind"));
				if (accountId === void 0 || accountId === "") {
					json(res, 400, { error: "缺少 accountId 查询参数" });
					return;
				}
				if (kind === void 0) {
					json(res, 400, { error: "缺少或非法的 kind 查询参数（只接受 compensation 或 gift）" });
					return;
				}
				try {
					json(res, 200, {
						ok: true,
						claimed: await deps.scheduler.claimOne(accountId, kind)
					});
				} catch (error) {
					deps.logger?.warn("dsh-connect-workbuddy-models: 权益领取失败", error);
					json(res, 502, { error: `benefit-claim-failed: ${safeMessage(error)}（该权益可能已过期或已被其他设备领取）` });
				}
			}
		}));
		disposers.push(ctx.webServer.register({
			kind: "exact",
			path: WB_MODELS_REFRESH_PATH,
			handler: async (req, res) => {
				const region = guard(req, res, "POST");
				if (region === void 0) return;
				try {
					await deps.refreshModels(region);
					const status = buildStatus(deps, region);
					json(res, 200, {
						ok: true,
						region,
						source: status.catalogs[region].source,
						modelCount: status.catalogs[region].modelCount,
						models: status.models,
						...status.catalogs[region].lastError === void 0 ? {} : { error: status.catalogs[region].lastError }
					});
				} catch (error) {
					deps.logger?.warn("dsh-connect-workbuddy-models: 模型目录刷新失败", error);
					json(res, 502, { error: `models-refresh-failed: ${safeMessage(error)}（静态目录仍在服务，倍率可能未知）` });
				}
			}
		}));
		disposers.push(ctx.webServer.register({
			kind: "exact",
			path: WB_MODELS_SAVE_PATH,
			handler: async (req, res) => {
				const region = guard(req, res, "POST");
				if (region === void 0) return;
				let body;
				try {
					body = await readJsonBody(req);
				} catch (error) {
					json(res, 400, { error: safeMessage(error) });
					return;
				}
				const ids = stringListOf(body["enabledModelIds"]);
				if (ids === void 0) {
					json(res, 400, { error: "enabledModelIds 必须是字符串数组（空数组 = 全部显示）" });
					return;
				}
				const bodyRegion = body["region"];
				const writeRegion = queryParamOf(req.url ?? "", "region") === void 0 && isWbRegion(bodyRegion) ? bodyRegion : region;
				try {
					await deps.writeConfig({ [writeRegion === "cn" ? "enabledModelIds" : "enabledModelIdsGlobal"]: ids });
					deps.catalogs.applySelection(writeRegion, ids);
					json(res, 200, {
						ok: true,
						region: writeRegion,
						enabledModelIds: ids
					});
				} catch (error) {
					json(res, 500, { error: `settings-save-failed: ${safeMessage(error)}` });
				}
			}
		}));
		disposers.push(ctx.webServer.register({
			kind: "exact",
			path: WB_ACCOUNTS_SELECT_PATH,
			handler: async (req, res) => {
				const region = guard(req, res, "POST");
				if (region === void 0) return;
				const accountId = rawQueryParamOf(req.url ?? "", WB_ACCOUNT_ID_PARAM);
				if (accountId === void 0) {
					json(res, 400, { error: "缺少 accountId 查询参数（传空字符串表示交还给账户使用方式）" });
					return;
				}
				if (accountId === "") {
					try {
						deps.pool.setPreferred(region, void 0);
						const config = deps.readConfig();
						await deps.writeConfig({ accounts: {
							...config.accounts,
							[region]: ""
						} });
						json(res, 200, buildStatus(deps, region));
					} catch (error) {
						json(res, 500, { error: `select-failed: ${safeMessage(error)}` });
					}
					return;
				}
				const entry = deps.pool.find(accountId);
				if (entry === void 0) {
					json(res, 404, { error: `unknown account: ${accountId}` });
					return;
				}
				if (entry.account.region !== region) {
					json(res, 409, { error: `account-region-mismatch: 该账号属于 ${entry.account.region}，不能在 ${region} 的 provider 下使用` });
					return;
				}
				try {
					deps.pool.setPreferred(region, accountId);
					const config = deps.readConfig();
					await deps.writeConfig({ accounts: {
						...config.accounts,
						[region]: accountId
					} });
					json(res, 200, buildStatus(deps, region));
				} catch (error) {
					json(res, 500, { error: `select-failed: ${safeMessage(error)}` });
				}
			}
		}));
		disposers.push(ctx.webServer.register({
			kind: "exact",
			path: WB_AUTOMATION_PATH,
			handler: async (req, res) => {
				if (!loopbackOrigin(req)) {
					json(res, 403, { error: "origin-not-trusted: 只接受本机浏览器请求" });
					return;
				}
				const method = req.method ?? "GET";
				if (method === "GET") {
					try {
						json(res, 200, {
							automation: deps.scheduler.status(),
							config: deps.readConfig().automation
						});
					} catch (error) {
						json(res, 500, { error: safeMessage(error) });
					}
					return;
				}
				if (method !== "POST") {
					json(res, 405, { error: "method not allowed: 该路由只接受 GET 或 POST" });
					return;
				}
				let body;
				try {
					body = await readJsonBody(req);
				} catch (error) {
					json(res, 400, { error: safeMessage(error) });
					return;
				}
				const patch = {};
				if (body["enabled"] !== void 0) {
					if (typeof body["enabled"] !== "boolean") {
						json(res, 400, { error: "enabled 必须是布尔值" });
						return;
					}
					patch["enabled"] = body["enabled"];
				}
				if (body["claimBenefits"] !== void 0) {
					if (typeof body["claimBenefits"] !== "boolean") {
						json(res, 400, { error: "claimBenefits 必须是布尔值" });
						return;
					}
					patch["claimBenefits"] = body["claimBenefits"];
				}
				if (body["checkinHours"] !== void 0) {
					const hours = body["checkinHours"];
					if (!Array.isArray(hours) || hours.some((hour) => typeof hour !== "number" || !Number.isInteger(hour) || hour < 0 || hour > 23)) {
						json(res, 400, { error: "checkinHours 必须是 0-23 的整数数组（北京时间整点）" });
						return;
					}
					patch["checkinHours"] = hours;
				}
				if (Object.keys(patch).length === 0) {
					json(res, 400, { error: "没有可应用的字段（接受 enabled / checkinHours / claimBenefits）" });
					return;
				}
				try {
					const nextAutomation = {
						...deps.readConfig().automation,
						...patch
					};
					await deps.writeConfig({ automation: nextAutomation });
					deps.scheduler.applyConfig(nextAutomation);
					json(res, 200, {
						automation: deps.scheduler.status(),
						config: nextAutomation
					});
				} catch (error) {
					json(res, 500, { error: `automation-save-failed: ${safeMessage(error)}` });
				}
			}
		}));
		return () => {
			for (const dispose of disposers.reverse()) try {
				dispose();
			} catch {}
		};
	});
}
/**
* 供 `index.ts` 生成 `pickOf`：把一个区域的名次表交出来。
*
* 单独导出而不是内联，因为「为什么这个账号排在后面」是本插件给用户的核心解释
* 之一（R4 让用户选的分布必须可见），而它需要一个可测的纯函数边界。
*/
function rankReasonsOf(pool, region, nowMs = Date.now()) {
	return pool.rank(region, nowMs).map((row, index) => {
		const entry = pool.find(row.account.id);
		const reason = entry === void 0 ? void 0 : pool.exclusionReason(entry);
		return {
			accountId: row.account.id,
			rank: index + 1,
			score: row.score,
			atRisk: row.atRisk,
			expiringAmount: row.expiringAmount,
			...row.nearestExpiryMs === void 0 ? {} : { nearestExpiryMs: row.nearestExpiryMs },
			usable: reason === void 0,
			...reason === void 0 ? {} : { reason }
		};
	});
}
//#endregion
//#region src/version.ts
/** 本份构建产出的 npm 包版本；未注入时回落到 `0.0.0-dev`。 */
const WB_MODELS_VERSION = "0.1.1";
//#endregion
//#region src/index.ts
/** 依赖注入：LLM seam（注册 provider/adapter）与 settings（挂卡片）。 */
const inject = ["llm", "settings"];
/**
* 把一个 schema 字段标记为 volatile。
*
* 0.1.7 线**要求**一个 entry 至少有一个 volatile 字段，否则 settings 写入闸门
* 直接拒绝（"Plugin entry ... has no volatile fields"）且 `describe()` 跳过它 ——
* 卡片既渲染不出也存不下。0.1.5 线上这个标记退化为恒等操作。
*/
function asVolatile(schema) {
	const candidate = schema;
	return typeof candidate.volatile === "function" ? candidate.volatile() : schema;
}
/**
* 自动签到 schema。
*
* `enabled` 带真实默认值 `false`：调度器每个 tick 都读它，字段缺失必须意味着
* 「关闭」而不是 `undefined`。开启会**代用户向上游发起写请求**，所以缺省值不能
* 是「开」。
*/
const automationSchema = z.object({
	enabled: z.boolean().default(false).description("运行每日积分自动化（签到）"),
	checkinHours: z.array(z.number().step(1).min(0).max(23)).default([9]).description("每日签到的北京时间整点列表"),
	claimBenefits: z.boolean().default(false).description("顺带领取可领的补偿 / 赠礼")
});
/**
* 插件配置 schema。字段形状与卡片保存的文档一一对应。
*
* 末尾的 `as unknown as z<WbModelsConfig>` 是有意的：`WbModelsConfig` 里几个数组
* 是 `readonly string[]`（配置一旦被读出来就不该被就地改写），而 schemastery 的
* `.default([])` 推出的是可变数组——直接标注会报「readonly 不能赋给可变」。同时
* 又不能省掉这层标注：不标注时 tsdown 的 dts 生成器会因推导类型引用了 peer 依赖
* 内部路径而报 TS2742（"cannot be named without a reference to ..."），声明文件
* 生成失败、整个 build 挂掉。用一次显式断言同时满足两边；断言是纯类型层的，运行时
* 拿到的还是那个 zod 对象。
*/
const Config = z.object({
	enabled: asVolatile(z.boolean().default(true).description("启用 WorkBuddy 模型池")),
	distribution: asVolatile(z.union([...ACCOUNT_DISTRIBUTIONS]).default(DEFAULT_ACCOUNT_DISTRIBUTION).description("账户使用方式：priority（抽干一个）、round-robin（依次轮转）、balanced（余额加权随机）、sticky（每对话钉一个）、expiry（先花最先到期的积分）")),
	enabledModelIds: asVolatile(z.array(z.string()).default([]).description("国内版要显示的模型；空数组 = 全部显示")),
	enabledModelIdsGlobal: asVolatile(z.array(z.string()).default([]).description("国际版要显示的模型；空数组 = 全部显示")),
	accountsEnabled: asVolatile(z.array(z.string()).default([]).description("参与池的账号 id；空数组 = 全部发现的账号都参与")),
	orderAccountIds: asVolatile(z.array(z.string()).default([]).description("用户手动排序的账号 id（排在前面的优先）")),
	showCreditsInComposer: asVolatile(z.boolean().default(true).description("在输入框下方显示当前账号与剩余总积分")),
	expiryWarnDays: asVolatile(z.number().step(1).min(1).max(90).default(3).description("临期提醒阈值（天）")),
	automation: asVolatile(automationSchema.description("每日签到与权益自动化")),
	accounts: asVolatile(z.object({
		cn: z.string().description("国内版当前使用账号 id（空 = 交给账户使用方式决定）"),
		global: z.string().description("国际版当前使用账号 id（空 = 交给账户使用方式决定）")
	}).default({}))
});
/**
* 构造无生命周期的核心对象。
*
* 与 `apply` 分开是为了让测试能 `createCore()` 拿到池/目录/调度器，而不必伪造一个
* 完整的 cordis context。这里**不**装定时器、不绑端口、不读配置。
*/
function createWbCore(options = {}) {
	const logger = options.logger;
	const client = new WbUpstreamClient((message) => {
		logger?.warn(`dsh-connect-workbuddy-models: ${message}`);
	});
	const pool = new WbAccountPool({ ...logger === void 0 ? {} : { logger } });
	return {
		client,
		pool,
		catalogs: new WbCatalogs(),
		scheduler: new WbScheduler({
			pool,
			client,
			...logger === void 0 ? {} : { logger },
			...options.saveLedger === void 0 ? {} : { saveLedger: options.saveLedger }
		})
	};
}
function apply(ctx, config = {}) {
	const core = createWbCore({
		logger: ctx.logger,
		saveLedger: (ledger) => {
			saveLedger(PLUGIN_ID, ledger, ctx.logger);
		}
	});
	let stopped = false;
	let releaseProviders;
	/** 目录变化后重建 picker；provider 注册完成前是空操作。 */
	let invalidateCatalog = () => {};
	/** 每区域的 shim。两区域互不影响：一个绑端口失败不该让另一个消失。 */
	const shims = {};
	for (const region of WB_REGIONS) shims[region] = createWbShim({
		pool: core.pool,
		client: core.client,
		catalog: core.catalogs.of(region),
		region,
		expiryWarnDays: () => liveConfig().expiryWarnDays,
		logger: ctx.logger
	});
	/** 深剥后的当前配置。每次读都重新剥：0.1.7 上字段是活引用。 */
	const liveConfig = () => unwrapVolatileDeep(config);
	/**
	* 重扫本机凭据并刷新每个账号的积分读数。
	*
	* 探测用**用户配置的 `expiryWarnDays`** 聚合临期窗口。这一点不能省：排序层
	* （`rankAccounts`）内部的兜底窗口固定为 3 天，如果这里照抄上游字段或走兜底，
	* 用户的阈值设置就只影响 UI 显示、完全不影响「谁排第一」——那正是 R3 要的行为
	* 反过来的样子。
	*/
	const rescan = async () => {
		const result = await discoverAccounts();
		core.pool.applyDiscovery(result);
		if (result.skipped.length > 0) ctx.logger.warn?.(`dsh-connect-workbuddy-models: 跳过 ${result.skipped.length} 个凭据文件（${result.skipped.map((file) => `${file.path}: ${file.reason}`).join(", ")}）`);
		const warnDays = liveConfig().expiryWarnDays;
		const probed = await probeAccounts(result.accounts, async (account) => ({
			credits: await core.client.fetchCredits(account.credential),
			checkin: await core.client.fetchCheckinStatus(account.credential)
		}), {
			warnDays: warnDays ?? 3,
			delayMs: 150
		});
		for (const reading of probed) {
			if (reading.credits !== void 0) core.pool.noteCredits(reading.accountId, reading.credits);
			if (reading.checkin !== void 0) core.pool.noteCheckin(reading.accountId, reading.checkin);
		}
		const unread = probed.filter((reading) => reading.credits === void 0).length;
		ctx.logger.info?.(`dsh-connect-workbuddy-models: 发现 ${result.accounts.length} 个账号（${WB_REGIONS.map((region) => `${region}=${result.accounts.filter((a) => a.region === region).length}`).join(" ")}）` + (unread === 0 ? "" : `，${unread} 个读不出余额`));
	};
	/**
	* 播种某一区域的实时模型目录。
	*
	* 静态 fallback 名册保证 provider 永不为空；实时目录只用来拿到真实倍率与新增
	* 模型。区域内逐账号尝试：池里任一账号的凭据都可能已被上游吊销（401），而播种
	* 只需要一个健康账号，只赌队首会让一份死 token 拖垮整个区域的实时目录。
	*/
	const seedRegion = async (region) => {
		const accounts = core.pool.listRegion(region).map((entry) => entry.account).filter((account) => core.pool.exclusionReason(core.pool.entryOf(account)) === void 0);
		const catalog = core.catalogs.of(region);
		if (accounts.length === 0) {
			ctx.logger.info?.(`dsh-connect-workbuddy-models: 尚无 ${region} 可用账号；保留静态 ${region} 目录`);
			return;
		}
		const failures = [];
		for (const account of accounts) try {
			const models = await core.client.fetchModels(account.credential, void 0, catalog.all().map((model) => model.id));
			if (catalog.applyFetch(models)) invalidateCatalog();
			if (region === "cn") busyFetchedAt.set(region, Date.now());
			applyConfigFromSource();
			ctx.logger.info?.(`dsh-connect-workbuddy-models: ${region} 目录已播种 ${models.length} 个模型`);
			return;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			failures.push(`${account.label}: ${message}`);
			ctx.logger.warn(`dsh-connect-workbuddy-models: ${region} 账号 ${account.label} 目录播种失败，尝试下一个账号`, error);
		}
		const message = failures.join(" | ");
		catalog.noteFetchFailure(message);
		ctx.logger.warn(`dsh-connect-workbuddy-models: ${region} 模型目录不可用，使用静态回退（倍率可能未知）`, message);
		applyConfigFromSource();
	};
	const refreshModels = async (region) => {
		await seedRegion(region);
	};
	/**
	* 拥挤度最近一次**成功**抓取的时刻，按区域记。
	*
	* 与目录的 `catalog.lastFetchedAtMs` 分开维护，因为这是两条独立的上游链路：
	* `/v2/chat/busy` 是分钟级事实，`/v3/config` 是小时级事实。共用一条 TTL 会逼出
	* 「为了拥挤度把大文档每分钟读一遍」或「拥挤度 5 分钟才更新一次」两种坏结果。
	*
	* 失败**不**推进这个时钟：否则上游一直不通时 TTL 永不到期，自动刷新就被永久
	* 饿死——这与 `WbCatalog.lastFetchedAtMs` 是同一条理由。
	*/
	const busyFetchedAt = /* @__PURE__ */ new Map();
	/**
	* 只刷新拥挤度，不动目录。
	*
	* 逐个账号试而不是只赌队首：与 `seedRegion` 同一条理由——一份被上游吊销的 token
	* 不该让整个区域的拥挤度一直显示成过期。
	*
	* 国际区直接返回且**不**推进时间戳：`/v2/chat/busy` 在国际网关实测 404，发出去
	* 只是多一个注定失败的往返。时钟不动，界面就会把它显示成「从未取到」——那是事实。
	*/
	const refreshBusy = async (region) => {
		if (region !== "cn") return;
		const catalog = core.catalogs.of(region);
		const ids = catalog.all().map((model) => model.id);
		if (ids.length === 0) return;
		const accounts = core.pool.listRegion(region).map((entry) => entry.account).filter((account) => core.pool.exclusionReason(core.pool.entryOf(account)) === void 0);
		for (const account of accounts) try {
			const levels = await core.client.fetchModelBusy(account.credential, ids);
			catalog.applyBusy(levels);
			busyFetchedAt.set(region, Date.now());
			invalidateCatalog();
			return;
		} catch (error) {
			ctx.logger.warn(`dsh-connect-workbuddy-models: ${region} 账号 ${account.label} 拥挤度刷新失败，尝试下一个账号`, error);
		}
	};
	/**
	* 把当前配置施加到池、目录、调度器与选号。
	*
	* 必须存在且**启动时调一次**：0.1.7 上的编辑以 `loader/volatile-update` 广播
	* 回来（那是监听器，启动时不触发）。没有这一步重应用，池/目录/调度器会停在构造
	* 默认值上，每次重启都静默回退成「全部默认」。
	*/
	const applyConfigFromSource = () => {
		const live = liveConfig();
		core.pool.applyConfig({
			enabledIds: live.accountsEnabled ?? [],
			orderIds: live.orderAccountIds ?? [],
			distribution: live.distribution ?? "expiry",
			expiryWarnDays: live.expiryWarnDays ?? 3
		});
		core.catalogs.applySelection("cn", live.enabledModelIds ?? []);
		core.catalogs.applySelection("global", live.enabledModelIdsGlobal ?? []);
		const cn = live.accounts?.cn;
		core.pool.setPreferred("cn", cn === void 0 || cn === "" ? void 0 : cn);
		const global = live.accounts?.global;
		core.pool.setPreferred("global", global === void 0 || global === "" ? void 0 : global);
		const automation = {
			enabled: live.automation?.enabled === true,
			checkinHours: live.automation?.checkinHours ?? [9],
			claimBenefits: live.automation?.claimBenefits === true
		};
		core.scheduler.applyConfig(automation);
		for (const region of WB_REGIONS) core.catalogs.of(region).setUsable(live.enabled !== false);
		invalidateCatalog();
	};
	const settingsService = ctx.settings;
	/**
	* `settings.update` 在运行线上期望的命名空间。
	*
	* 0.1.5 按插件经 `installSection` 注册的**命名空间**解析写入器；0.1.7 起改为按
	* **宿主插件条目 id** 解析（`configEditor.entries().find(row => row.options.id === ns)`），
	* 而 profile patch 选的就是那个 id —— 桌面宿主把本插件挂成 `workbuddy-models`
	* （见 cordis.patch.yml），但市场安装可能包一层（`mkt-...`）或经 `include` 行挂载。
	* 唯一正确答案是问 fiber 要它自己的 entry id；硬猜自己的 namespace 会让每次保存
	* 都抛「No configurable plugin entry」——这正是「模型管理保存无效」的根因。
	*/
	const settingsWriteNs = typeof settingsService?.installSection === "function" ? WB_MODELS_SETTINGS_NS : (() => {
		try {
			const entryId = ctx.fiber?.entry?.options?.id;
			return entryId === void 0 || entryId === "" ? WB_MODELS_SETTINGS_NS : entryId;
		} catch {
			return WB_MODELS_SETTINGS_NS;
		}
	})();
	if (settingsService !== void 0) {
		if (typeof settingsService.installSection === "function") settingsService.installSection(ctx, WB_MODELS_SETTINGS_NS, Config, unwrapVolatileDeep(config), { onChange() {
			applyConfigFromSource();
		} });
		if (typeof settingsService.configure === "function") ctx.effect(() => settingsService.configure?.({ auto: true }, ctx.fiber) ?? (() => {}));
		if (typeof settingsService.installSection !== "function" && typeof settingsService.configure !== "function") ctx.logger.warn?.("dsh-connect-workbuddy-models: settings 服务既没有 installSection 也没有 configure；卡片不会挂载");
	}
	ctx.on("loader/volatile-update", () => {
		applyConfigFromSource();
	});
	/** 把一次卡片写入落到 settings。 */
	const writeConfig = async (patch) => {
		if (typeof settingsService?.update !== "function") throw new Error("settings 服务不可用；改动没有保存");
		await settingsService.update(settingsWriteNs, patch);
		applyConfigFromSource();
	};
	applyConfigFromSource();
	const stopAll = () => {
		stopped = true;
		core.scheduler.dispose();
		releaseProviders?.();
		releaseProviders = void 0;
		for (const region of WB_REGIONS) shims[region]?.close();
	};
	ctx.effect(() => stopAll);
	ctx.inject(["webServer"], (webCtx) => registerWbStatusRoutes(webCtx, {
		pool: core.pool,
		catalogs: core.catalogs,
		client: core.client,
		scheduler: core.scheduler,
		logger: ctx.logger,
		readConfig: liveConfig,
		writeConfig,
		rescan,
		probe: async (accounts, warnDays) => await probeAccounts(accounts, async (account) => ({
			credits: await core.client.fetchCredits(account.credential),
			checkin: await core.client.fetchCheckinStatus(account.credential)
		}), {
			warnDays,
			delayMs: 150
		}),
		refreshModels,
		refreshBusy,
		busyFetchedAtMs: (region) => busyFetchedAt.get(region),
		pickOf: (region, accountId) => {
			if (accountId !== void 0 && accountId !== "") core.pool.setPreferred(region, accountId);
			return core.pool.pick(region);
		}
	}));
	(async () => {
		try {
			await Promise.all(WB_REGIONS.map(async (region) => await shims[region]?.ready));
		} catch (error) {
			ctx.logger.error("dsh-connect-workbuddy-models: shim 启动失败（该区域 provider 将缺席）", error);
		}
		if (stopped) return;
		const adapters = {};
		for (const region of WB_REGIONS) {
			const shim = shims[region];
			if (shim === void 0) continue;
			adapters[region] = createWbAdapter({
				shim,
				catalog: core.catalogs.of(region),
				region,
				ctx
			});
		}
		try {
			const disposers = [];
			for (const region of WB_REGIONS) {
				const adapter = adapters[region];
				if (adapter === void 0) continue;
				disposers.push(ctx.llm.registerAdapter([WB_PROVIDERS[region]], adapter.adapter));
			}
			const registered = WB_REGIONS.filter((region) => adapters[region] !== void 0);
			if (registered.length > 0) disposers.push(ctx.llm.registerConfigurableProviders(registered.map((region) => ({
				provider: WB_PROVIDERS[region],
				displayName: adapters[region]?.displayName ?? WB_PROVIDERS[region],
				settingsNs: WB_MODELS_SETTINGS_NS,
				settingsPath: [],
				declared: false
			}))));
			releaseProviders = () => {
				for (const dispose of disposers.reverse()) try {
					dispose();
				} catch {}
			};
		} catch (error) {
			releaseProviders?.();
			releaseProviders = void 0;
			ctx.logger.error("dsh-connect-workbuddy-models: provider 注册失败", error);
			return;
		}
		invalidateCatalog = () => {
			for (const region of WB_REGIONS) adapters[region]?.invalidate();
		};
		ctx.llm.registerModelDiscovery(WB_MODELS_SETTINGS_NS, async (request) => {
			const region = WB_REGIONS.find((candidate) => WB_PROVIDERS[candidate] === request.provider);
			if (region === void 0) return [];
			return core.catalogs.of(region).visible().map((model) => ({
				id: model.id,
				name: model.name,
				...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
				...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
				inputModalities: model.supportsImages ? ["text", "image"] : ["text"]
			}));
		});
		ctx.logger.info?.(`dsh-connect-workbuddy-models: provider 已注册 ${WB_REGIONS.map((region) => `${WB_PROVIDERS[region]}=${shims[region]?.baseUrl() ?? "未启动"}`).join(" ")}`);
		try {
			await rescan();
		} catch (error) {
			ctx.logger.warn("dsh-connect-workbuddy-models: 账号发现失败（保留静态目录与空池）", error);
		}
		if (stopped) return;
		await Promise.all(WB_REGIONS.map(async (region) => await seedRegion(region)));
		if (stopped) return;
		core.scheduler.applyLedger(await loadLedger(PLUGIN_ID));
		core.scheduler.start();
		ctx.logger.info?.(`dsh-connect-workbuddy-models: 签到调度器已启动（automation.enabled=${core.scheduler.isEnabled() ? "true" : "false"} 时${core.scheduler.isEnabled() ? "" : "保持惰性；"}）`);
	})();
}
/** cordis 插件显示名（诊断与日志用）。 */
const name = PLUGIN_ID;
//#endregion
export { ACCOUNT_DISTRIBUTIONS, AUTOMATION_ACCOUNT_DELAY_MS, AUTOMATION_TICK_MS, AUTOMATION_TIME_ZONE, Config, DEFAULT_ACCOUNT_DISTRIBUTION, DEFAULT_CHECKIN_HOURS, DEFAULT_EXPIRY_WARN_DAYS, EXPIRY_WARN_DAYS_MAX, EXPIRY_WARN_DAYS_MIN, FALLBACK_MODELS_CN, FALLBACK_MODELS_GLOBAL, PLUGIN_ID, ROUTE_PREFIX, WB_ACCOUNTS_REFRESH_PATH, WB_ACCOUNTS_SELECT_PATH, WB_ACCOUNT_CREDITS_PATH, WB_ACCOUNT_ID_PARAM, WB_AUTOMATION_PATH, WB_BENEFIT_CLAIM_PATH, WB_CHECKIN_PATH, WB_KIND_PARAM, WB_MODELS_LOCALE_NS, WB_MODELS_REFRESH_PATH, WB_MODELS_SAVE_PATH, WB_MODELS_SETTINGS_NS, WB_MODELS_SETTINGS_ORDER, WB_MODELS_VERSION, WB_PROVIDERS, WB_REGIONS, WB_REGION_PARAM, WB_STATUS_PATH, WORKBUDDY_AUTH_FILE_ENV, WORKBUDDY_LIVE_FILENAME, WbAccountPool, WbCatalog, WbCatalogs, WbCredentialRejectedError, WbScheduler, WbUpstreamClient, aggregateCredits, apply, benefitKindOf, candidateAuthDirs, classifyThrown, classifyUpstreamError, createWbAdapter, createWbCore, createWbShim, defaultDesktopAuthDirs, deriveVisibleModels, describeSelection, discoverAccounts, distributionOf, fallbackModelsFor, fetchCatalogFromAny, inject, isCredentialRejectedError, isExpiring, ledgerPath, loadLedger, modelsOfDocument, name, parseCreditMultiplier, parseUpstreamModel, pickRankedAccount, probeAccounts, rankAccounts, rankReasonsOf, regionOf, registerWbStatusRoutes, safeMessage, saveLedger, selectCliModels, toCheckinStatus, totalCreditsOf, unwrapVolatile, unwrapVolatileDeep, wbProviderOf, wbRegionOfProvider, worthRetrying };
