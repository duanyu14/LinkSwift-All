// ==UserScript==
// @name         UC Episode Finder 
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  翻页扫描定位最大集数文件（综合集数+时间）并高亮显示
// @author       烟雨烟中客
// @match        https://drive.uc.cn/s/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const HIGHLIGHT_COLOR = "#FFF59D";
    const MAX_SCAN_PAGES = 200;
    const PAGE_LOAD_TIMEOUT = 10000;
    const MAX_CONSECUTIVE_FAIL = 3;

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function clickElement(el) {
        if (!el) return false;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.click();
        return true;
    }

    function highlightElement(el) {
        if (!el) return;
        const originalBg = el.style.backgroundColor;
        el.style.transition = "background-color 0.3s";
        el.style.backgroundColor = HIGHLIGHT_COLOR;
        setTimeout(() => {
            el.style.backgroundColor = originalBg;
        }, 3000);
    }

    // 友好的浮层提示，替代原生 alert
    function showToast(message, type = "info") {
        const colors = {
            info:    { bg: "#323232", border: "#666666" },
            success: { bg: "#2E7D32", border: "#4CAF50" },
            warn:    { bg: "#E65100", border: "#FF9800" },
            error:   { bg: "#C62828", border: "#EF5350" }
        };
        const c = colors[type] || colors.info;
        const toast = document.createElement("div");
        toast.textContent = message;
        toast.style.cssText = `
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: ${c.bg};
            color: #fff;
            padding: 12px 24px;
            border-radius: 6px;
            border: 1px solid ${c.border};
            z-index: 999999;
            font-size: 14px;
            line-height: 1.5;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            opacity: 0;
            transition: opacity 0.3s ease;
            max-width: 80vw;
            word-break: break-all;
            font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
        `;
        document.body.appendChild(toast);
        requestAnimationFrame(() => { toast.style.opacity = "1"; });
        setTimeout(() => {
            toast.style.opacity = "0";
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    }

    // 检测登录态：通过隐藏 iframe 打开网盘首页，已登录会被前端路由到 /list#/list/all
    function checkLogin(timeout = 8000) {
        return new Promise((resolve) => {
            const iframe = document.createElement("iframe");
            iframe.style.cssText = "width:0;height:0;border:0;position:absolute;left:-9999px;top:-9999px;";
            iframe.src = "https://drive.uc.cn/";
            document.body.appendChild(iframe);

            const start = Date.now();
            let done = false;

            function finish(result) {
                if (done) return;
                done = true;
                clearInterval(pollId);
                iframe.remove();
                resolve(result);
            }

            const pollId = setInterval(() => {
                try {
                    const href = iframe.contentWindow.location.href;
                    // 已登录：首页会被前端路由到 /list#/list/all
                    if (href && href.indexOf("/list") !== -1) {
                        finish(true);
                        return;
                    }
                } catch (e) {
                    // 跨域或未就绪，继续等待
                }
                if (Date.now() - start >= timeout) {
                    finish(false);
                }
            }, 400);
        });
    }

    function extractNumberFromFilename(filename) {
        // 1. 中文「第N集」
        const chnMatch = filename.match(/第(\d{1,3})集/);
        if (chnMatch) return parseInt(chnMatch[1], 10);

        // 2. 同时含季和集（S01E12 / s1e12）：综合为 季*100 + 集，避免丢失集数
        const seasonEpMatch = filename.match(/S(\d{1,2})E(\d{1,3})/i);
        if (seasonEpMatch) {
            return parseInt(seasonEpMatch[1], 10) * 100 + parseInt(seasonEpMatch[2], 10);
        }

        // 3. 仅含季（S01），用负向前瞻排除后跟 E 的情况（兜底防御）
        const seasonMatch = filename.match(/S(\d{1,2})(?!E\d)/i);
        if (seasonMatch) return parseInt(seasonMatch[1], 10) * 100;

        // 4. 仅含集（E12）
        const episodeMatch = filename.match(/E(\d{1,3})/i);
        if (episodeMatch) return parseInt(episodeMatch[1], 10);

        // 5. 独立数字
        const match = filename.match(/\b(\d{1,3})\b/);
        if (match) return parseInt(match[1], 10);

        // 6. 紧跟大写字母前的数字
        const numMatch = filename.match(/(\d{1,3})(?=\s*[A-Z])/);
        if (numMatch) return parseInt(numMatch[1], 10);

        return 0;
    }

    async function waitForRows() {
        const start = Date.now();
        while (Date.now() - start < 10000) {
            const rows = document.querySelectorAll("tr.ant-table-row");
            if (rows.length > 0) return true;
            await sleep(500);
        }
        return false;
    }

    function getCurrentPageFiles() {
        const items = [];
        const rows = document.querySelectorAll("tr.ant-table-row");
        for (const row of rows) {
            const filenameSpan = row.querySelector(".filename-text span");
            if (!filenameSpan) continue;
            const filename = filenameSpan.getAttribute("title") || filenameSpan.innerText;
            if (!filename || filename.trim() === "") continue;

            let fileTime = null;
            const tds = row.querySelectorAll("td");
            if (tds.length >= 4) {
                const timeCell = tds[tds.length - 1];
                const timeText = timeCell.innerText.trim();
                if (timeText && timeText.match(/\d{4}-\d{2}-\d{2}/)) {
                    fileTime = new Date(timeText.replace(' ', 'T'));
                }
            }

            items.push({
                filename: filename.trim(),
                rowElement: row,
                fileTime: fileTime
            });
        }
        return items;
    }

    async function clickNextPage() {
        const nextLi = document.querySelector("li.ant-pagination-next:not(.ant-pagination-disabled)");
        if (!nextLi) return false;
        const nextLink = nextLi.querySelector("a");
        if (!nextLink) return false;

        clickElement(nextLink);
        console.log("⏩ 已点击下一页");

        const start = Date.now();
        let rowsBefore = document.querySelectorAll("tr.ant-table-row").length;
        while (Date.now() - start < PAGE_LOAD_TIMEOUT) {
            await sleep(500);
            const rowsAfter = document.querySelectorAll("tr.ant-table-row").length;
            if (rowsAfter > 0 && rowsAfter !== rowsBefore) break;
            const activePage = document.querySelector(".ant-pagination-item-active");
            if (activePage && activePage.innerText.trim()) {
                await sleep(300);
                break;
            }
        }
        return true;
    }

    async function clickPrevPage() {
        const prevLi = document.querySelector("li.ant-pagination-prev:not(.ant-pagination-disabled)");
        if (!prevLi) return false;
        const prevLink = prevLi.querySelector("a");
        if (!prevLink) return false;

        clickElement(prevLink);
        console.log("⏪ 已点击上一页");

        const start = Date.now();
        let rowsBefore = document.querySelectorAll("tr.ant-table-row").length;
        while (Date.now() - start < PAGE_LOAD_TIMEOUT) {
            await sleep(500);
            const rowsAfter = document.querySelectorAll("tr.ant-table-row").length;
            if (rowsAfter > 0 && rowsAfter !== rowsBefore) break;
            const activePage = document.querySelector(".ant-pagination-item-active");
            if (activePage && activePage.innerText.trim()) {
                await sleep(300);
                break;
            }
        }
        return true;
    }

    // 获取当前激活页码（从 class ant-pagination-item-{N} 提取，回退到文本）
    function getActivePageIndex() {
        const active = document.querySelector(".ant-pagination-item-active");
        if (!active) return 1;
        const clsMatch = Array.from(active.classList)
            .find(c => /^ant-pagination-item-\d+$/.test(c));
        if (clsMatch) return parseInt(clsMatch.replace("ant-pagination-item-", ""), 10);
        return parseInt(active.innerText.trim(), 10) || 1;
    }

    function isInsideTargetDirectory() {
        const breadcrumbs = document.querySelectorAll(".bcrumb-filename");
        const breadcrumbTexts = Array.from(breadcrumbs).map(el => el.getAttribute("title") || el.innerText.trim());
        const otherDirs = breadcrumbTexts.filter(text => text !== "全部文件");
        if (otherDirs.length > 0) {
            console.log(`📍 检测到已在目录内，面包屑包含: ${breadcrumbTexts.join(" > ")}`);
            return true;
        } else {
            console.log("📁 当前面包屑只有“全部文件”，尚未进入具体目录");
            return false;
        }
    }

    async function enterFirstDirectory() {
        console.log("🔍 正在寻找分享页面中的目录...");
        const rows = document.querySelectorAll("tr.ant-table-row");
        for (const row of rows) {
            const tds = row.querySelectorAll("td");
            if (tds.length >= 3) {
                const sizeCell = tds[2];
                const sizeText = sizeCell.innerText.trim();
                if (sizeText === "-") {
                    const filenameDiv = row.querySelector(".filename-text");
                    if (filenameDiv) {
                        console.log("✅ 找到目录，即将点击进入:", filenameDiv.innerText);
                        clickElement(filenameDiv);
                        await sleep(2000);
                        await waitForRows();
                        return true;
                    }
                }
            }
        }
        const anyDir = document.querySelector(".filename-text");
        if (anyDir) {
            console.warn("⚠️ 未通过大小列识别到目录，将尝试点击第一个文件名元素");
            clickElement(anyDir);
            await sleep(2000);
            await waitForRows();
            return true;
        }
        console.error("❌ 未找到任何目录");
        return false;
    }

    async function findMaxFileInfo() {
        let maxNumber = -1;
        let maxFilename = "";
        let maxFileTime = null;
        let maxFilePageIndex = 1;   // 记录目标文件所在页码，供定位阶段直接跳转
        let pageIndex = 1;
        let consecutiveFail = 0;

        while (pageIndex <= MAX_SCAN_PAGES) {
            console.log(`📄 正在扫描第 ${pageIndex} 页...`);
            const files = getCurrentPageFiles();
            for (const file of files) {
                const num = extractNumberFromFilename(file.filename);
                const time = file.fileTime;

                let shouldUpdate = false;
                if (num > maxNumber) {
                    shouldUpdate = true;
                } else if (num === maxNumber) {
                    if (time && (!maxFileTime || time > maxFileTime)) {
                        shouldUpdate = true;
                    }
                }

                if (shouldUpdate) {
                    maxNumber = num;
                    maxFilename = file.filename;
                    maxFileTime = time;
                    maxFilePageIndex = pageIndex;  // 更新目标页码
                    const timeStr = time ? time.toLocaleString() : "无时间";
                    console.log(`✨ 发现更大集数: ${file.filename} → 集数 ${num} (时间: ${timeStr}, 页: ${pageIndex})`);
                }
            }

            const nextLi = document.querySelector("li.ant-pagination-next:not(.ant-pagination-disabled)");
            if (nextLi) {
                const success = await clickNextPage();
                if (!success) {
                    consecutiveFail++;
                    if (consecutiveFail >= MAX_CONSECUTIVE_FAIL) {
                        console.warn("⚠️ 连续翻页失败，停止扫描");
                        break;
                    }
                    await sleep(1000);
                } else {
                    consecutiveFail = 0;
                    pageIndex++;
                }
            } else {
                console.log("🏁 已到达最后一页");
                break;
            }
        }

        if (maxNumber === -1) {
            console.warn("⚠️ 未找到任何包含数字的文件");
            return null;
        }
        const timeStr = maxFileTime ? maxFileTime.toLocaleString() : "无时间";
        console.log(`🏆 最大集数文件: “${maxFilename}” (集数 ${maxNumber}, 时间: ${timeStr}, 页: ${maxFilePageIndex})`);
        return { maxNumber, maxFilename, maxFilePageIndex };
    }

    // 尝试直接点击分页器中的目标页码，避免逐页翻阅
    async function jumpToPage(targetPage) {
        if (!targetPage || targetPage < 1) return false;
        if (getActivePageIndex() === targetPage) return true; // 已在目标页
        const pageItem = document.querySelector(`.ant-pagination-item-${targetPage}`);
        if (!pageItem || pageItem.classList.contains("ant-pagination-disabled")) return false;
        const link = pageItem.querySelector("a");
        if (!link) return false;
        clickElement(link);
        console.log(`↪️ 尝试直接跳转到第 ${targetPage} 页`);
        await sleep(1500);
        await waitForRows();
        return true;
    }

    async function onlyHighlightMaxFile(targetNumber, targetFilename, targetPageIndex) {
        console.log(`🔎 定位最大集数文件（仅高亮，目标页: ${targetPageIndex || 1}）...`);

        // 扫描阶段结束时停留在最后一页，这里不再 goToFirstPage，
        // 而是直接从当前页向前回到目标页，避免与首次扫描路径重复。
        let pageIndex = getActivePageIndex();
        const target = targetPageIndex || 1;

        // 1) 优先直接点击分页器中的目标页码
        if (pageIndex !== target) {
            const jumped = await jumpToPage(target);
            if (jumped) {
                pageIndex = target;
            }
        }

        // 2) jumpToPage 失败（目标页码未渲染）时，向前翻页直到抵达目标页
        let consecutiveFail = 0;
        while (pageIndex > target) {
            const success = await clickPrevPage();
            if (!success) {
                consecutiveFail++;
                if (consecutiveFail >= MAX_CONSECUTIVE_FAIL) break;
                await sleep(1000);
            } else {
                consecutiveFail = 0;
                pageIndex = getActivePageIndex();
                if (pageIndex <= target) break;
            }
        }

        // 3) 抵达目标页后扫描；若未命中则继续向后兜底（同名同集文件可能在后续页）
        consecutiveFail = 0;
        while (pageIndex <= MAX_SCAN_PAGES) {
            console.log(`🔍 定位扫描第 ${pageIndex} 页...`);
            const files = getCurrentPageFiles();
            for (const file of files) {
                const num = extractNumberFromFilename(file.filename);
                if (num === targetNumber && file.filename === targetFilename) {
                    console.log(`🎯 找到目标文件: ${file.filename}`);
                    const targetRow = file.rowElement;
                    highlightElement(targetRow);
                    targetRow.scrollIntoView({ behavior: "smooth", block: "center" });
                    targetRow.style.border = "2px solid #FFB74D";
                    console.log("✅ 已高亮最大集数文件");
                    return true;
                }
            }

            const nextLi = document.querySelector("li.ant-pagination-next:not(.ant-pagination-disabled)");
            if (nextLi) {
                const success = await clickNextPage();
                if (!success) {
                    consecutiveFail++;
                    if (consecutiveFail >= MAX_CONSECUTIVE_FAIL) break;
                    await sleep(1000);
                } else {
                    consecutiveFail = 0;
                    pageIndex++;
                }
            } else {
                break;
            }
        }
        console.error(`❌ 在所有页面中未找到目标文件: ${targetFilename}`);
        return false;
    }

    async function main() {
        console.log("🚀 UC网盘扫描定位脚本已启动");

        try {
            // 动作之前：先检测登录态
            showToast("正在检测登录状态...", "info");
            const loggedIn = await checkLogin();
            if (!loggedIn) {
                console.warn("⚠️ 未检测到登录状态");
                showToast("未检测到登录状态，请在新标签页登录 UC 网盘后重试。", "warn");
                // 便于用户一键前往登录：打开网盘首页（未登录会停在登录引导）
                if (confirm("检测到未登录 UC 网盘，是否打开登录页面？")) {
                    window.open("https://drive.uc.cn/", "_blank");
                }
                return;
            }
            console.log("✅ 登录状态正常");
            showToast("登录状态正常，开始扫描...", "success");

            await waitForRows();

            const alreadyInside = isInsideTargetDirectory();
            if (!alreadyInside) {
                console.log("尚未进入具体目录，尝试自动进入...");
                const entered = await enterFirstDirectory();
                if (!entered) {
                    showToast("未找到可进入的目录，请检查页面是否已加载完成。", "warn");
                    return;
                }
            } else {
                console.log("已处于目标目录内，跳过目录选择步骤。");
            }

            const maxInfo = await findMaxFileInfo();
            if (!maxInfo) {
                showToast("未找到任何包含集数数字的文件，无法执行后续操作。", "warn");
                return;
            }

            const { maxNumber, maxFilename, maxFilePageIndex } = maxInfo;
            const ok = await onlyHighlightMaxFile(maxNumber, maxFilename, maxFilePageIndex);
            if (ok) {
                showToast(`已定位到最大集数文件：${maxFilename}`, "success");
            } else {
                showToast(`未能在页面中定位目标文件：${maxFilename}`, "error");
            }
        } catch (err) {
            console.error("❌ 脚本执行异常:", err);
            showToast(`脚本执行异常：${err && err.message ? err.message : err}`, "error");
        }
    }

    setTimeout(main, 2000);
})();