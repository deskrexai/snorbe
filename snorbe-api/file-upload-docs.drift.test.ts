/**
 * Skill ドキュメント の 対応拡張子・サイズ・ファイル数上限 が
 * runtime 定数 (`file-constants.ts`) と drift していないか の 検知テスト.
 *
 * 拡張子 が 追加/削除 された のに .md を 直し忘れる 事故 を CI で 弾く。
 * failure 時 は 該当 定数 と .md の 両方 を 同期 させる (docs を 手で 更新)。
 *
 * 対象:
 *   - reference/file-upload.md
 *   - capabilities.md (「## ファイル添付 (fileUrls)」節)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
	ALL_SUPPORTED_EXTENSIONS,
	IMAGE_MAX_SIZE,
	MAX_FILE_COUNT,
	OTHER_MAX_SIZE,
} from "~/features/turn/utils/file-constants";

const SKILL_DIR = resolve(__dirname);
const REFERENCE_MD = resolve(SKILL_DIR, "reference/file-upload.md");
const CAPABILITIES_MD = resolve(SKILL_DIR, "capabilities.md");

const readDoc = (p: string) => readFileSync(p, "utf8");
const imageMB = () => IMAGE_MAX_SIZE / 1024 / 1024;
const otherMB = () => OTHER_MAX_SIZE / 1024 / 1024;

describe("snorbe-api skill docs vs file-constants (drift)", () => {
	for (const path of [REFERENCE_MD, CAPABILITIES_MD]) {
		describe(path.replace(SKILL_DIR + "/", ""), () => {
			const md = readDoc(path);

			it.each([
				...ALL_SUPPORTED_EXTENSIONS,
			])("documents extension %s (backtick-wrapped)", (ext) => {
				// `.pdf` の 形 で 記載 されている ことを 検証 (誤って 括弧なし で 書かれる の を 防ぐ)
				expect(md).toContain(`\`${ext}\``);
			});

			it("documents image size limit as MB", () => {
				expect(md).toContain(`${imageMB()}MB`);
			});

			it("documents other size limit as MB", () => {
				expect(md).toContain(`${otherMB()}MB`);
			});

			it("documents max file count", () => {
				// 「最大 10 ファイル」の 数字 は 定数 由来
				expect(md).toMatch(new RegExp(`${MAX_FILE_COUNT}\\s*ファイル`));
			});

			it("does NOT list extensions that are no longer supported", () => {
				// backtick で 囲まれた `.foo` を 全部拾い、定数外 が いないか 検証.
				// 誤検知 回避: 前後 の 説明文 (「対応拡張子」の 表 に 出てくる もの) だけ を 対象 に する.
				const bulletExts = md.match(/`\.[a-z0-9]+`/gi) ?? [];
				const unique = new Set(bulletExts.map((s) => s.replace(/`/g, "")));
				const supported = new Set<string>(ALL_SUPPORTED_EXTENSIONS);
				for (const ext of unique) {
					// 「非対応 だが プレビュー可 」等 の 説明 に 出る 拡張子 は 許容
					// (gif/webp/svg は file-constants の コメント にも あるとおり preview only)
					if ([".gif", ".webp", ".svg"].includes(ext)) continue;
					expect(
						supported.has(ext),
						`${ext} は 定数外 なのに doc に 記載`,
					).toBe(true);
				}
			});
		});
	}
});
