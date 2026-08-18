/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Flex } from "@components/Flex";
import { FormSwitch } from "@components/FormSwitch";
import { HeadingSecondary } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import definePlugin from "@utils/types";
import { Channel, Message, RenderModalProps } from "@vencord/discord-types";
import { AuthenticationStore, ChannelStore, Constants, createRoot, Menu, Modal, openModal, RestAPI, Toasts, useEffect, useState } from "@webpack/common";

const DISCORD_EPOCH = 1420070400000n;

function dateToSnowflake(date: Date): string {
    const timestamp = BigInt(date.getTime());
    if (timestamp < DISCORD_EPOCH) return "0";
    return ((timestamp - DISCORD_EPOCH) << 22n).toString();
}

function showToast(message: string, type = Toasts.Type.MESSAGE) {
    Toasts.show({
        id: Toasts.genId(),
        message,
        type,
        options: { position: Toasts.Position.BOTTOM }
    });
}

function sanitizeHtml(str: string): string {
    return (str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;")
        .replace(/\n/g, "<br/>");
}

function getChannelDisplayName(channel: Channel): string {
    if (channel.name) return channel.name;
    if (channel.rawRecipients && channel.rawRecipients.length > 0) {
        return channel.rawRecipients.map((u: any) => u.global_name || u.username).join(", ");
    }
    return `channel-${channel.id}`;
}

function downloadFile(content: string, filename: string, mimeType: string) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export type ExportFormat = "HtmlDark" | "HtmlLight" | "Json" | "Csv" | "PlainText";

export interface ExportProgress {
    count: number;
    rate: number;
    percentage: number;
    etaText: string;
}

interface ExportOptions {
    format: ExportFormat;
    afterDate?: string;
    beforeDate?: string;
    maxMessages?: number;
    includeBotMessages: boolean;
    reverseOrder?: boolean;
    respectRateLimits?: boolean;
}

function formatDuration(seconds: number): string {
    if (seconds < 0 || !isFinite(seconds)) return "Estimating...";
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return `${mins}m ${secs}s`;
}

export interface ActiveExportTask {
    id: string;
    channelName: string;
    controller: AbortController;
    progress: ExportProgress;
}

const taskListeners = new Set<() => void>();
export const activeExportTasks = new Map<string, ActiveExportTask>();

function notifyTaskUpdate() {
    taskListeners.forEach(fn => fn());
}

export function ActiveExportsDock() {
    const [, forceUpdate] = useState({});

    useEffect(() => {
        const update = () => forceUpdate({});
        taskListeners.add(update);
        return () => { taskListeners.delete(update); };
    }, []);

    if (activeExportTasks.size === 0) return null;

    return (
        <div className="vc-ce-manager-dock">
            {Array.from(activeExportTasks.values()).map(task => (
                <div key={task.id} className="vc-ce-task-card">
                    <div className="vc-ce-task-header">
                        <div className="vc-ce-task-title">
                            📥 #{task.channelName}
                        </div>
                        <button
                            className="vc-ce-cancel-btn"
                            title="Cancel Export"
                            onClick={() => {
                                task.controller.abort();
                                activeExportTasks.delete(task.id);
                                notifyTaskUpdate();
                                showToast(`Export for #${task.channelName} canceled.`, Toasts.Type.MESSAGE);
                            }}
                        >
                            ✕ Cancel
                        </button>
                    </div>

                    <div className="vc-ce-task-bar-bg">
                        <div
                            className="vc-ce-task-bar-fill"
                            style={{ width: `${Math.min(100, Math.max(0, task.progress.percentage))}%` }}
                        />
                    </div>

                    <div className="vc-ce-task-meta">
                        <span><b>{task.progress.count.toLocaleString()}</b> msgs ({task.progress.rate}/s)</span>
                        <span>{task.progress.percentage}% • {task.progress.etaText}</span>
                    </div>
                </div>
            ))}
        </div>
    );
}

const GROUPING_TIME_THRESHOLD_MS = 7 * 60 * 1000;

interface MessageGroup {
    author: {
        id: string;
        name: string;
        username: string;
        avatarUrl: string;
        isBot: boolean;
    };
    firstTimestamp: Date;
    messages: any[];
}

function groupMessages(messages: any[]): MessageGroup[] {
    const groups: MessageGroup[] = [];
    let currentGroup: MessageGroup | null = null;

    for (const msg of messages) {
        const msgTime = new Date(msg.timestamp);
        const authorId = msg.author?.id || "unknown";
        const authorName = msg.author?.global_name || msg.author?.username || "Unknown";
        const username = msg.author?.username || "unknown";
        const isBot = Boolean(msg.author?.bot);
        const avatarUrl = msg.author?.avatar
            ? `https://cdn.discordapp.com/avatars/${msg.author.id}/${msg.author.avatar}.png?size=64`
            : "https://cdn.discordapp.com/embed/avatars/0.png";

        const shouldStartNewGroup =
            !currentGroup ||
            currentGroup.author.id !== authorId ||
            msgTime.getTime() - currentGroup.firstTimestamp.getTime() > GROUPING_TIME_THRESHOLD_MS ||
            msgTime.getDate() !== currentGroup.firstTimestamp.getDate();

        if (shouldStartNewGroup) {
            currentGroup = {
                author: {
                    id: authorId,
                    name: authorName,
                    username,
                    avatarUrl,
                    isBot,
                },
                firstTimestamp: msgTime,
                messages: [msg],
            };
            groups.push(currentGroup);
        } else {
            currentGroup.messages.push(msg);
        }
    }

    return groups;
}

async function fetchBatch(channelId: string, query: Record<string, any>, signal?: AbortSignal) {
    const token = AuthenticationStore?.getToken?.();
    const queryString = new URLSearchParams(query).toString();
    const url = `https://discord.com/api/v10/channels/${channelId}/messages?${queryString}`;

    if (token) {
        const response = await fetch(url, {
            headers: {
                Authorization: token,
                "Content-Type": "application/json"
            },
            cache: "no-store",
            keepalive: true,
            priority: "high",
            signal
        } as any);

        if (response.status === 429) {
            const body = await response.json().catch(() => ({}));
            const retryAfter = Number(body.retry_after ?? response.headers.get("retry-after") ?? 1.2);
            throw { status: 429, body: { retry_after: retryAfter } };
        }

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const remaining = response.headers.get("x-ratelimit-remaining");
        const resetAfter = response.headers.get("x-ratelimit-reset-after");
        const body = await response.json();

        return {
            body,
            headers: {
                "x-ratelimit-remaining": remaining,
                "x-ratelimit-reset-after": resetAfter
            }
        };
    }

    return RestAPI.get({
        url: Constants.Endpoints.MESSAGES(channelId),
        query,
        retries: 3
    });
}

async function fetchMessagesFast(
    channelId: string,
    options: ExportOptions,
    abortSignal: AbortSignal,
    onProgress: (progress: ExportProgress) => void
): Promise<Message[]> {
    const allMessages: any[] = [];
    const beforeSnowflake = options.beforeDate ? dateToSnowflake(new Date(options.beforeDate)) : undefined;
    const afterSnowflake = options.afterDate ? dateToSnowflake(new Date(options.afterDate)) : undefined;
    const maxCount = options.maxMessages && options.maxMessages > 0 ? options.maxMessages : Infinity;
    const isReverse = Boolean(options.reverseOrder);
    const respectRateLimits = options.respectRateLimits !== false;

    if (abortSignal.aborted) throw { isCanceled: true };

    let omegaTimestamp: number | null = null;
    try {
        const omegaRes = await fetchBatch(channelId, { limit: 1, ...(beforeSnowflake ? { before: beforeSnowflake } : {}) }, abortSignal);
        if (omegaRes?.body?.[0]?.timestamp) {
            omegaTimestamp = new Date(omegaRes.body[0].timestamp).getTime();
        }
    } catch (e: any) {
        if (abortSignal.aborted || e?.name === "AbortError") throw { isCanceled: true };
    }

    let alphaTimestamp: number | null = null;
    let currentBoundary = !isReverse ? (afterSnowflake ?? "0") : beforeSnowflake;
    const startTime = Date.now();
    let lastProgressUpdate = 0;

    const buildQuery = (boundary: string | undefined, countNeeded: number) => {
        const query: Record<string, any> = { limit: Math.min(100, countNeeded) };
        if (!isReverse) {
            query.after = boundary;
        } else if (boundary) {
            query.before = boundary;
        }
        return query;
    };

    let pendingFetch: Promise<any> | null = fetchBatch(channelId, buildQuery(currentBoundary, maxCount - allMessages.length), abortSignal);

    while (allMessages.length < maxCount) {
        if (abortSignal.aborted || !pendingFetch) throw { isCanceled: true };

        try {
            const res = await pendingFetch;
            if (abortSignal.aborted) throw { isCanceled: true };

            let messages: any[] = res?.body ?? [];
            if (!messages || messages.length === 0) break;

            if (!isReverse) {
                messages.sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? 1 : -1));
            } else {
                messages.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1));
            }

            if (alphaTimestamp === null && messages.length > 0) {
                alphaTimestamp = new Date(messages[0].timestamp).getTime();
            }

            const nextBoundary = messages[messages.length - 1].id;
            const countAfterThis = allMessages.length + messages.length;
            const hasMore = messages.length === 100 && countAfterThis < maxCount;

            if (hasMore && !abortSignal.aborted) {
                pendingFetch = fetchBatch(channelId, buildQuery(nextBoundary, maxCount - countAfterThis), abortSignal);
            } else {
                pendingFetch = null;
            }

            for (const msg of messages) {
                if (!isReverse && beforeSnowflake && BigInt(msg.id) >= BigInt(beforeSnowflake)) {
                    return allMessages;
                }
                if (isReverse && afterSnowflake && BigInt(msg.id) <= BigInt(afterSnowflake)) {
                    return allMessages;
                }

                if (!options.includeBotMessages && msg.author?.bot) continue;
                allMessages.push(msg);
                if (allMessages.length >= maxCount) break;
            }

            const now = Date.now();
            if (now - lastProgressUpdate > 100 || allMessages.length >= maxCount) {
                const elapsedSec = Math.max(0.1, (now - startTime) / 1000);
                const rate = Math.round(allMessages.length / elapsedSec);

                let fraction = 0;
                if (maxCount !== Infinity && maxCount > 0) {
                    fraction = Math.min(1, allMessages.length / maxCount);
                } else if (alphaTimestamp !== null && omegaTimestamp !== null && omegaTimestamp > alphaTimestamp) {
                    const currentMsgTimestamp = new Date(messages[messages.length - 1].timestamp).getTime();
                    const totalSpan = Math.abs(omegaTimestamp - alphaTimestamp);
                    const currentSpan = Math.abs(currentMsgTimestamp - alphaTimestamp);
                    fraction = Math.min(1, Math.max(0, currentSpan / totalSpan));
                }

                const percent = Math.round(fraction * 100);
                let etaText = "Estimating...";
                if (fraction > 0.02 && fraction < 1) {
                    const totalEstimatedSec = elapsedSec / fraction;
                    const remainingSec = Math.max(0, totalEstimatedSec - elapsedSec);
                    etaText = `~${formatDuration(remainingSec)}`;
                } else if (fraction >= 1) {
                    etaText = "Finishing...";
                }

                onProgress({
                    count: allMessages.length,
                    rate,
                    percentage: percent,
                    etaText
                });
                lastProgressUpdate = now;
            }

            if (!hasMore || !pendingFetch) break;

            currentBoundary = nextBoundary;

            if (respectRateLimits) {
                const remaining = Number(res?.headers?.["x-ratelimit-remaining"] ?? 5);
                const resetAfter = Number(res?.headers?.["x-ratelimit-reset-after"] ?? 0);
                if (remaining === 0 && resetAfter > 0) {
                    await new Promise(r => setTimeout(r, resetAfter * 1000 + 20));
                }
            }
        } catch (err: any) {
            if (abortSignal.aborted || err?.isCanceled || err?.name === "AbortError") {
                throw { isCanceled: true };
            }
            if (err?.status === 429) {
                const retryAfter = (err?.body?.retry_after ?? 1.2) * 1000;
                await new Promise(r => setTimeout(r, retryAfter + 50));
                pendingFetch = fetchBatch(channelId, buildQuery(currentBoundary, maxCount - allMessages.length), abortSignal);
                continue;
            }
            throw err;
        }
    }

    return isReverse ? allMessages.reverse() : allMessages;
}

function formatMarkdown(text: string): string {
    if (!text) return "";
    let formatted = sanitizeHtml(text);

    formatted = formatted.replace(/```(?:([a-zA-Z0-9_-]+)\n)?([\s\S]*?)```/g, (_, lang, code) => {
        return `<pre style="background: rgba(0, 0, 0, 0.2); padding: 10px; border-radius: 4px; font-family: Consolas, monospace; font-size: 13px; margin: 6px 0; overflow-x: auto;"><code>${code}</code></pre>`;
    });

    formatted = formatted.replace(/`([^`\n]+)`/g, '<code style="background: rgba(0, 0, 0, 0.2); padding: 2px 4px; border-radius: 3px; font-family: Consolas, monospace; font-size: 85%;">$1</code>');
    formatted = formatted.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    formatted = formatted.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
    formatted = formatted.replace(/(^|[^_])_([^_]+)_/g, "$1<em>$2</em>");
    formatted = formatted.replace(/__([^_]+)__/g, "<u>$1</u>");
    formatted = formatted.replace(/~~([^~]+)~~/g, "<s>$1</s>");

    formatted = formatted.replace(/&lt;(a)?:([a-zA-Z0-9_~]+):([0-9]+)&gt;/g, (_, animated, name, id) => {
        const ext = animated ? "gif" : "png";
        return `<img class="emoji" alt=":${name}:" title=":${name}:" src="https://cdn.discordapp.com/emojis/${id}.${ext}?size=48" style="width: 22px; height: 22px; vertical-align: -4px; object-fit: contain;" />`;
    });

    formatted = formatted.replace(/&lt;@!?([0-9]+)&gt;/g, '<span style="background: rgba(88, 101, 242, 0.15); color: #c9cdfb; padding: 0 4px; border-radius: 3px; font-weight: 500;">@User</span>');
    formatted = formatted.replace(/&lt;#([0-9]+)&gt;/g, '<span style="background: rgba(88, 101, 242, 0.15); color: #c9cdfb; padding: 0 4px; border-radius: 3px; font-weight: 500;">#channel</span>');
    formatted = formatted.replace(/&lt;@&amp;([0-9]+)&gt;/g, '<span style="background: rgba(88, 101, 242, 0.15); color: #c9cdfb; padding: 0 4px; border-radius: 3px; font-weight: 500;">@role</span>');
    formatted = formatted.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noreferrer" style="color: #00a8fc; text-decoration: none;">$1</a>');

    return formatted;
}

function formatHtml(channelName: string, channelId: string, messages: any[], theme: "dark" | "light"): string {
    const isDark = theme === "dark";
    const bg = isDark ? "#313338" : "#ffffff";
    const fg = isDark ? "#dbdee1" : "#313338";
    const headerBg = isDark ? "#2b2d31" : "#f2f3f5";
    const authorColor = isDark ? "#f2f3f5" : "#060607";
    const hoverBg = isDark ? "#2e3035" : "#f8f9fa";
    const border = isDark ? "#1e1f22" : "#e3e5e8";
    const subText = isDark ? "#949ba4" : "#5c5e66";
    const embedBg = isDark ? "#2b2d31" : "#f2f3f5";

    const groups = groupMessages(messages);

    const groupsHtml = groups.map(group => {
        const timestampStr = group.firstTimestamp.toLocaleString();
        const botBadge = group.author.isBot
            ? `<span style="background: #5865f2; color: #ffffff; font-size: 10px; font-weight: 700; padding: 1px 4px; border-radius: 3px; margin-left: 4px; text-transform: uppercase;">BOT</span>`
            : "";

        const messagesHtml = group.messages.map((msg, idx) => {
            const content = formatMarkdown(msg.content);
            const msgTime = new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            const editedHtml = msg.edited_timestamp
                ? `<span style="font-size: 10px; color: ${subText}; margin-left: 4px; opacity: 0.7;">(edited)</span>`
                : "";

            let replyHtml = "";
            if (msg.referenced_message) {
                const ref = msg.referenced_message;
                const refAuthor = ref.author?.global_name || ref.author?.username || "Unknown";
                const refAvatar = ref.author?.avatar
                    ? `https://cdn.discordapp.com/avatars/${ref.author.id}/${ref.author.avatar}.png?size=32`
                    : "https://cdn.discordapp.com/embed/avatars/0.png";
                const refContent = sanitizeHtml((ref.content || "").slice(0, 100)) || "Click to see attachment";
                replyHtml = `
                <div class="chatlog__reference" style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px; font-size: 13px; color: ${subText};">
                    <span style="opacity: 0.5;">┌</span>
                    <img src="${refAvatar}" style="width: 16px; height: 16px; border-radius: 50%;" />
                    <span style="font-weight: 600; color: ${authorColor};">${sanitizeHtml(refAuthor)}</span>
                    <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 400px; opacity: 0.8;">${refContent}</span>
                </div>`;
            }

            let attachmentsHtml = "";
            if (msg.attachments?.length) {
                attachmentsHtml = msg.attachments.map((a: any) => {
                    if (a.content_type?.startsWith("image/")) {
                        return `<div style="margin-top: 6px;"><a href="${a.url}" target="_blank"><img src="${a.url}" loading="lazy" style="max-width: 450px; max-height: 350px; border-radius: 8px;"/></a></div>`;
                    }
                    return `<div style="margin-top: 4px;"><a href="${a.url}" target="_blank" style="color: #00a8fc; text-decoration: none; font-size: 14px;">📎 ${sanitizeHtml(a.filename)}</a></div>`;
                }).join("");
            }

            let stickersHtml = "";
            if (msg.sticker_items?.length) {
                stickersHtml = msg.sticker_items.map((st: any) => {
                    return `<div style="margin-top: 6px;"><img src="https://media.discordapp.net/stickers/${st.id}.png?size=160" alt="${sanitizeHtml(st.name)}" style="width: 160px; height: 160px; object-fit: contain;" /></div>`;
                }).join("");
            }

            let embedsHtml = "";
            if (msg.embeds?.length) {
                embedsHtml = msg.embeds.map((em: any) => {
                    const title = em.title ? `<h4 style="margin: 0 0 4px 0; color: ${authorColor}; font-size: 14px;">${sanitizeHtml(em.title)}</h4>` : "";
                    const desc = em.description ? `<p style="margin: 0; font-size: 13px; line-height: 1.3;">${sanitizeHtml(em.description)}</p>` : "";
                    const color = em.color ? (em.color).toString(16).padStart(6, "0") : "5865f2";
                    return `<div style="border-left: 4px solid #${color}; padding: 8px 12px; margin-top: 6px; background: ${embedBg}; border-radius: 4px; max-width: 520px;">${title}${desc}</div>`;
                }).join("");
            }

            let reactionsHtml = "";
            if (msg.reactions?.length) {
                reactionsHtml = `<div class="chatlog__reactions" style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px;">` +
                    msg.reactions.map((r: any) => {
                        const emojiUrl = r.emoji?.id ? `https://cdn.discordapp.com/emojis/${r.emoji.id}.png?size=32` : null;
                        const emojiElem = emojiUrl
                            ? `<img src="${emojiUrl}" style="width: 16px; height: 16px; margin-right: 4px;" />`
                            : `<span style="margin-right: 4px;">${r.emoji?.name || "👍"}</span>`;
                        return `<div style="display: inline-flex; align-items: center; background: ${headerBg}; border: 1px solid ${border}; border-radius: 8px; padding: 2px 6px; font-size: 12px; color: ${subText};">${emojiElem}<span>${r.count}</span></div>`;
                    }).join("") +
                `</div>`;
            }

            return `
            <div class="chatlog__message" style="position: relative; margin-top: ${idx === 0 ? "0" : "4px"};">
                ${replyHtml}
                <span class="chatlog__short-timestamp" style="display: none; position: absolute; left: -56px; font-size: 11px; color: ${subText}; width: 44px; text-align: right;">${msgTime}</span>
                <div class="chatlog__content" style="font-size: 15px; line-height: 1.375rem; word-break: break-word;">${content}${editedHtml}</div>
                ${attachmentsHtml}
                ${stickersHtml}
                ${embedsHtml}
                ${reactionsHtml}
            </div>`;
        }).join("");

        return `
        <div class="chatlog__message-group" style="display: flex; margin-bottom: 16px; padding: 4px 8px 4px 8px; border-radius: 4px;">
            <div class="chatlog__author-avatar-container" style="width: 40px; height: 40px; margin-right: 16px; flex-shrink: 0;">
                <img class="chatlog__author-avatar" src="${group.author.avatarUrl}" alt="${sanitizeHtml(group.author.username)}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover;" />
            </div>
            <div class="chatlog__messages" style="flex-grow: 1; min-width: 0;">
                <div class="chatlog__header" style="display: flex; align-items: baseline; gap: 6px; margin-bottom: 4px;">
                    <span class="chatlog__author-name" style="font-weight: 600; color: ${authorColor}; font-size: 15px;">${sanitizeHtml(group.author.name)}</span>
                    ${botBadge}
                    <span class="chatlog__author-username" style="font-size: 12px; color: ${subText};">@${sanitizeHtml(group.author.username)}</span>
                    <span class="chatlog__timestamp" style="font-size: 12px; color: ${subText}; margin-left: 4px;">${timestampStr}</span>
                </div>
                ${messagesHtml}
            </div>
        </div>`;
    }).join("\n");

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>${sanitizeHtml(channelName)}</title>
    <style>
        body { background-color: ${bg}; color: ${fg}; font-family: 'gg sans', 'Noto Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif; margin: 0; padding: 24px; }
        .header { background: ${headerBg}; padding: 20px; border-radius: 8px; margin-bottom: 24px; border: 1px solid ${border}; }
        .header h1 { margin: 0 0 8px 0; font-size: 22px; color: ${authorColor}; }
        .header p { margin: 0; font-size: 14px; color: ${subText}; }
        .chatlog__message-group:hover { background-color: ${hoverBg}; }
        .chatlog__message-group:hover .chatlog__short-timestamp { display: inline-block !important; }
    </style>
</head>
<body>
    <div class="header">
        <h1>${sanitizeHtml(channelName)}</h1>
        <p>Channel ID: ${channelId} | Exported: ${new Date().toLocaleString()} | Total Messages: ${messages.length}</p>
    </div>
    <div class="chatlog">
        ${groupsHtml}
    </div>
</body>
</html>`;
}

function formatCsv(messages: any[]): string {
    const header = ["MessageID", "AuthorID", "Author", "Date", "Content", "Attachments", "Reactions", "Stickers", "ReplyTo"].join(",");
    const rows = messages.map(msg => {
        const msgId = `"${msg.id || ""}"`;
        const authorId = `"${msg.author?.id || ""}"`;
        const author = `"${(msg.author?.global_name || msg.author?.username || "").replace(/"/g, '""')}"`;
        const date = `"${new Date(msg.timestamp).toISOString()}"`;
        const content = `"${(msg.content || "").replace(/"/g, '""')}"`;
        const attachments = `"${(msg.attachments?.map((a: any) => a.url) || []).join(" ")}"`;
        const reactions = `"${(msg.reactions?.map((r: any) => `${r.emoji.name}:${r.count}`) || []).join(" ")}"`;
        const stickers = `"${(msg.sticker_items?.map((s: any) => s.name) || []).join(" ")}"`;
        const replyTo = `"${msg.referenced_message?.id || ""}"`;
        return [msgId, authorId, author, date, content, attachments, reactions, stickers, replyTo].join(",");
    });
    return [header, ...rows].join("\n");
}

function formatPlainText(channelName: string, channelId: string, messages: any[]): string {
    const header = `====================================================\nChannel: ${channelName} (${channelId})\nExport Date: ${new Date().toLocaleString()}\nTotal Messages: ${messages.length}\n====================================================\n\n`;
    const lines = messages.map(msg => {
        const author = msg.author?.global_name || msg.author?.username || "Unknown";
        const date = new Date(msg.timestamp).toISOString().replace("T", " ").substring(0, 19);
        let text = `[${date}] ${author}: ${msg.content || ""}`;
        if (msg.attachments?.length) {
            text += `\n  [Attachments: ${msg.attachments.map((a: any) => a.url).join(", ")}]`;
        }
        return text;
    });
    return header + lines.join("\n");
}

function ExportConfigModal({ channel, modalProps }: { channel: Channel; modalProps: RenderModalProps; }) {
    const [format, setFormat] = useState<ExportFormat>("HtmlDark");
    const [afterDate, setAfterDate] = useState<string>("");
    const [beforeDate, setBeforeDate] = useState<string>("");
    const [maxMessages, setMaxMessages] = useState<string>("");
    const [includeBots, setIncludeBots] = useState<boolean>(true);
    const [hyperSpeed, setHyperSpeed] = useState<boolean>(true);

    const [isExporting, setIsExporting] = useState<boolean>(false);
    const [progress, setProgress] = useState<ExportProgress>({
        count: 0,
        rate: 0,
        percentage: 0,
        etaText: "Estimating...",
    });

    const channelName = getChannelDisplayName(channel);

    const handleStartExport = async () => {
        const taskId = `${channel.id}-${Date.now()}`;
        const controller = new AbortController();
        const initialProgress: ExportProgress = { count: 0, rate: 0, percentage: 0, etaText: "Estimating..." };

        activeExportTasks.set(taskId, {
            id: taskId,
            channelName,
            controller,
            progress: initialProgress
        });
        notifyTaskUpdate();

        setIsExporting(true);
        setProgress(initialProgress);

        try {
            const messages = await fetchMessagesFast(
                channel.id,
                {
                    format,
                    afterDate: afterDate || undefined,
                    beforeDate: beforeDate || undefined,
                    maxMessages: maxMessages ? parseInt(maxMessages, 10) : undefined,
                    includeBotMessages: includeBots,
                    respectRateLimits: !hyperSpeed,
                },
                controller.signal,
                p => {
                    setProgress(p);
                    const task = activeExportTasks.get(taskId);
                    if (task) {
                        task.progress = p;
                        notifyTaskUpdate();
                    }
                }
            );

            if (controller.signal.aborted) {
                showToast(`Export for #${channelName} canceled.`, Toasts.Type.MESSAGE);
                return;
            }

            if (messages.length === 0) {
                showToast("No messages found matching your criteria.", Toasts.Type.WARNING);
                return;
            }

            const safeName = channelName.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
            const dateStr = new Date().toISOString().substring(0, 10);

            switch (format) {
                case "HtmlDark":
                    downloadFile(formatHtml(channelName, channel.id, messages, "dark"), `${safeName}_${dateStr}.html`, "text/html");
                    break;
                case "HtmlLight":
                    downloadFile(formatHtml(channelName, channel.id, messages, "light"), `${safeName}_${dateStr}.html`, "text/html");
                    break;
                case "Json":
                    downloadFile(
                        JSON.stringify({ channel: { id: channel.id, name: channelName }, count: messages.length, messages }, null, 2),
                        `${safeName}_${dateStr}.json`,
                        "application/json"
                    );
                    break;
                case "Csv":
                    downloadFile(formatCsv(messages), `${safeName}_${dateStr}.csv`, "text/csv");
                    break;
                case "PlainText":
                    downloadFile(formatPlainText(channelName, channel.id, messages), `${safeName}_${dateStr}.txt`, "text/plain");
                    break;
            }

            showToast(`Exported ${messages.length.toLocaleString()} messages successfully!`, Toasts.Type.SUCCESS);
            modalProps.onClose();
        } catch (err: any) {
            if (controller.signal.aborted || err?.isCanceled) {
                showToast(`Export for #${channelName} canceled.`, Toasts.Type.MESSAGE);
            } else {
                console.error("[ChatExporter] Export failed:", err);
                showToast(`Export failed: ${err.message || "Unknown error"}`, Toasts.Type.FAILURE);
            }
        } finally {
            activeExportTasks.delete(taskId);
            notifyTaskUpdate();
            setIsExporting(false);
        }
    };

    return (
        <Modal
            {...modalProps}
            size="md"
            title={`Export Chat - #${channelName}`}
            subtitle="Configure export settings before downloading."
            actions={isExporting ? [
                {
                    text: "Cancel Export",
                    variant: "dangerPrimary",
                    onClick: () => {
                        const task = Array.from(activeExportTasks.values()).find(t => t.channelName === channelName);
                        task?.controller.abort();
                        setIsExporting(false);
                    }
                }
            ] : [
                {
                    text: "Cancel",
                    variant: "secondary",
                    onClick: modalProps.onClose
                },
                {
                    text: "Export",
                    variant: "primary",
                    onClick: handleStartExport
                }
            ]}
        >
            {isExporting ? (
                <div className="vc-ce-progress-box">
                    <HeadingSecondary>Exporting Messages...</HeadingSecondary>
                    <div className="vc-ce-progress-count">
                        {progress.count.toLocaleString()} messages ({progress.rate} msgs/sec)
                    </div>

                    <div style={{
                        width: "100%",
                        height: "10px",
                        backgroundColor: "var(--background-secondary-alt, #1e1f22)",
                        borderRadius: "5px",
                        overflow: "hidden",
                        margin: "6px 0",
                        border: "1px solid var(--input-border, #3b3e45)"
                    }}>
                        <div style={{
                            width: `${Math.min(100, Math.max(0, progress.percentage))}%`,
                            height: "100%",
                            backgroundColor: "var(--brand-500, #5865f2)",
                            transition: "width 0.2s ease"
                        }} />
                    </div>

                    <div style={{
                        display: "flex",
                        justifyContent: "space-between",
                        width: "100%",
                        fontSize: "13px",
                        color: "var(--text-muted, #949ba4)"
                    }}>
                        <span>Progress: <b>{progress.percentage}%</b></span>
                        <span>Estimated Time: <b>{progress.etaText}</b></span>
                    </div>
                </div>
            ) : (
                <div className="vc-ce-modal">
                    <div className="vc-ce-section">
                        <div className="vc-ce-label">Export Format</div>
                        <select
                            className="vc-ce-select"
                            value={format}
                            onChange={e => setFormat(e.target.value as ExportFormat)}
                        >
                            <option value="HtmlDark">HTML (Dark Theme - Discord Styled)</option>
                            <option value="HtmlLight">HTML (Light Theme - Discord Styled)</option>
                            <option value="Json">JSON (Full message & metadata)</option>
                            <option value="Csv">CSV (Spreadsheet compatible)</option>
                            <option value="PlainText">Plain Text (.txt)</option>
                        </select>
                    </div>

                    <div className="vc-ce-section">
                        <div className="vc-ce-label">Date Range (Optional)</div>
                        <div className="vc-ce-row">
                            <div className="vc-ce-col">
                                <div style={{ fontSize: "12px", color: "var(--text-muted, #949ba4)", marginBottom: "4px" }}>After (From Date):</div>
                                <input
                                    className="vc-ce-input"
                                    type="datetime-local"
                                    value={afterDate}
                                    onChange={e => setAfterDate(e.target.value)}
                                />
                            </div>
                            <div className="vc-ce-col">
                                <div style={{ fontSize: "12px", color: "var(--text-muted, #949ba4)", marginBottom: "4px" }}>Before (To Date):</div>
                                <input
                                    className="vc-ce-input"
                                    type="datetime-local"
                                    value={beforeDate}
                                    onChange={e => setBeforeDate(e.target.value)}
                                />
                            </div>
                        </div>
                    </div>

                    <div className="vc-ce-section">
                        <div className="vc-ce-label">Message Limit (Optional)</div>
                        <input
                            className="vc-ce-input"
                            type="number"
                            placeholder="All messages (e.g. 500)"
                            value={maxMessages}
                            onChange={e => setMaxMessages(e.target.value)}
                        />
                    </div>

                    <div className="vc-ce-section" style={{ marginTop: "8px" }}>
                        <FormSwitch
                            title="Include Bot Messages"
                            description="Include messages sent by Discord bots."
                            value={includeBots}
                            onChange={setIncludeBots}
                            hideBorder
                        />
                        <FormSwitch
                            title="Hyper-Speed Mode"
                            description="Ignore advisory rate limits (pause only on HTTP 429)."
                            value={hyperSpeed}
                            onChange={setHyperSpeed}
                            hideBorder
                        />
                    </div>
                </div>
            )}
        </Modal>
    );
}

function openExportModal(channel: Channel) {
    openModal(modalProps => (
        <ExportConfigModal channel={channel} modalProps={modalProps} />
    ));
}

const contextMenuPatch: NavContextMenuPatchCallback = (children, { channel, user }: any) => {
    const targetChannel = channel ?? (user ? ChannelStore.getDMFromUserId(user.id) : null);
    if (!targetChannel) return;

    children.push(
        <Menu.MenuGroup key="vc-chat-exporter-group">
            <Menu.MenuItem
                id="vc-chat-exporter"
                label="Export Chat"
                action={() => openExportModal(targetChannel)}
            />
        </Menu.MenuGroup>
    );
};

let dockContainer: HTMLDivElement | null = null;
let dockRoot: any = null;

export default definePlugin({
    name: "ChatExporter",
    description: "High-speed chat exporter based on DiscordChatExporter with date filtering, limits, and multi-format exports.",
    authors: [
        {
            name: "qssaf",
            id: 0n,
        },
    ],

    contextMenus: {
        "channel-context": contextMenuPatch,
        "thread-context": contextMenuPatch,
        "user-context": contextMenuPatch,
        "gdm-context": contextMenuPatch,
    },

    start() {
        if (!dockContainer && typeof document !== "undefined") {
            dockContainer = document.createElement("div");
            dockContainer.id = "vc-ce-dock-container";
            document.body.appendChild(dockContainer);
            if (createRoot) {
                dockRoot = createRoot(dockContainer);
                dockRoot.render(<ActiveExportsDock />);
            }
        }
    },

    stop() {
        if (dockRoot) {
            dockRoot.unmount();
            dockRoot = null;
        }
        if (dockContainer) {
            dockContainer.remove();
            dockContainer = null;
        }
    }
});
