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

interface StreamWriter {
    write(chunk: string): Promise<void>;
    close(): Promise<void>;
}

async function createStreamWriter(suggestedFilename: string, format: ExportFormat): Promise<StreamWriter> {
    const ext = format === "Json" ? "json" : format === "Csv" ? "csv" : format === "PlainText" ? "txt" : "html";
    const mime = format === "Json" ? "application/json" : format === "Csv" ? "text/csv" : format === "PlainText" ? "text/plain" : "text/html";

    if (typeof (window as any).showSaveFilePicker === "function") {
        try {
            const handle = await (window as any).showSaveFilePicker({
                suggestedName: suggestedFilename,
                types: [{
                    description: `${format} file`,
                    accept: { [mime]: [`.${ext}`] }
                }]
            });
            const writable = await handle.createWritable();
            return {
                async write(chunk: string) {
                    await writable.write(chunk);
                },
                async close() {
                    await writable.close();
                }
            };
        } catch (e: any) {
            if (e?.name === "AbortError") {
                throw { isCanceled: true };
            }
        }
    }

    const buffer: string[] = [];
    return {
        async write(chunk: string) {
            buffer.push(chunk);
        },
        async close() {
            downloadFile(buffer.join(""), suggestedFilename, mime);
        }
    };
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

function renderHtmlHeader(channelName: string, channelId: string, isDark: boolean): string {
    const bg = isDark ? "#36393e" : "#ffffff";
    const fg = isDark ? "#dcddde" : "#23262a";
    const authorColor = isDark ? "#ffffff" : "#2f3136";
    const linkColor = isDark ? "#00aff4" : "#0068e0";
    const subText = isDark ? "#a3a6aa" : "#5e6772";
    const borderCol = isDark ? "rgba(255, 255, 255, 0.1)" : "#eceeef";
    const hoverBg = isDark ? "#32353b" : "#fafafa";
    const embedBg = isDark ? "rgba(46, 48, 54, 0.3)" : "rgba(249, 249, 249, 0.3)";
    const embedBorder = isDark ? "rgba(46, 48, 54, 0.6)" : "rgba(204, 204, 204, 0.3)";
    const reactionBg = isDark ? "#2f3136" : "#f2f3f5";

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <title>Export - ${sanitizeHtml(channelName)}</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width">
    <style>
        @@font-face {
            src: url("https://cdn.jsdelivr.net/gh/Tyrrrz/DiscordFonts@master/ggsans-normal-400.woff2");
            font-family: gg sans;
            font-weight: 400;
            font-style: normal;
        }
        @@font-face {
            src: url("https://cdn.jsdelivr.net/gh/Tyrrrz/DiscordFonts@master/ggsans-normal-600.woff2");
            font-family: gg sans;
            font-weight: 600;
            font-style: normal;
        }
        html, body {
            margin: 0;
            padding: 0;
            background-color: ${bg};
            color: ${fg};
            font-family: "gg sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
            font-size: 17px;
            font-weight: 400;
            scroll-behavior: smooth;
        }
        a {
            color: ${linkColor};
            text-decoration: none;
        }
        a:hover {
            text-decoration: underline;
        }
        img {
            object-fit: contain;
            image-rendering: high-quality;
        }
        .preamble {
            display: grid;
            grid-template-columns: auto 1fr;
            max-width: 100%;
            padding: 1.25rem;
            border-bottom: 1px solid ${borderCol};
        }
        .preamble__entries-container {
            grid-column: 2;
            margin-left: 1rem;
        }
        .preamble__entry {
            margin-bottom: 0.2rem;
            color: ${authorColor};
            font-size: 1.4rem;
            font-weight: 600;
        }
        .preamble__entry--small {
            font-size: 1rem;
            font-weight: 400;
            color: ${subText};
        }
        .chatlog {
            padding: 1rem 0;
            width: 100%;
        }
        .chatlog__message-group {
            margin-bottom: 1rem;
        }
        .chatlog__message-container {
            background-color: transparent;
            transition: background-color 1s ease;
        }
        .chatlog__message-container--highlighted {
            background-color: rgba(114, 137, 218, 0.2);
        }
        .chatlog__message {
            display: grid;
            grid-template-columns: auto 1fr;
            padding: 0.15rem 0;
        }
        .chatlog__message:hover {
            background-color: ${hoverBg};
        }
        .chatlog__message:hover .chatlog__short-timestamp {
            display: block;
        }
        .chatlog__message-aside {
            grid-column: 1;
            width: 72px;
            padding: 0.15rem 0.15rem 0 0.15rem;
            text-align: center;
        }
        .chatlog__reply-symbol {
            height: 10px;
            margin: 6px 4px 4px 36px;
            border-left: 2px solid ${subText};
            border-top: 2px solid ${subText};
            border-top-left-radius: 8px;
        }
        .chatlog__avatar {
            width: 40px;
            height: 40px;
            border-radius: 50%;
        }
        .chatlog__short-timestamp {
            display: none;
            color: ${subText};
            font-size: 0.75rem;
            font-weight: 500;
        }
        .chatlog__message-primary {
            grid-column: 2;
            min-width: 0;
        }
        .chatlog__reply {
            display: flex;
            margin-bottom: 0.15rem;
            align-items: center;
            color: ${subText};
            font-size: 0.875rem;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .chatlog__reply-avatar {
            width: 16px;
            height: 16px;
            margin-right: 0.25rem;
            border-radius: 50%;
        }
        .chatlog__reply-author {
            margin-right: 0.3rem;
            font-weight: 600;
            color: ${authorColor};
        }
        .chatlog__reply-content {
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .chatlog__reply-link {
            cursor: pointer;
        }
        .chatlog__reply-link:hover {
            color: ${authorColor};
        }
        .chatlog__header {
            margin-bottom: 0.1rem;
        }
        .chatlog__author {
            font-weight: 600;
            color: ${authorColor};
        }
        .chatlog__author-tag {
            position: relative;
            top: -0.1rem;
            margin-left: 0.3rem;
            padding: 0.05rem 0.3rem;
            border-radius: 3px;
            background-color: #5865F2;
            color: #ffffff;
            font-size: 0.625rem;
            font-weight: 500;
        }
        .chatlog__timestamp {
            margin-left: 0.3rem;
            color: ${subText};
            font-size: 0.75rem;
            font-weight: 500;
        }
        .chatlog__timestamp a {
            color: inherit;
        }
        .chatlog__content {
            padding-right: 1rem;
            font-size: 0.95rem;
            word-wrap: break-word;
            line-height: 1.375;
        }
        .chatlog__edited-timestamp {
            margin-left: 0.15rem;
            color: ${subText};
            font-size: 0.75rem;
            font-weight: 500;
        }
        .chatlog__attachment {
            position: relative;
            width: fit-content;
            margin-top: 0.3rem;
            border-radius: 3px;
            overflow: hidden;
        }
        .chatlog__attachment-media {
            max-width: 45vw;
            max-height: 500px;
            vertical-align: top;
            border-radius: 3px;
        }
        .chatlog__attachment-generic {
            max-width: 520px;
            width: 100%;
            height: 40px;
            padding: 10px;
            border: 1px solid ${borderCol};
            border-radius: 3px;
            background-color: ${reactionBg};
            overflow: hidden;
            margin-top: 4px;
        }
        .chatlog__attachment-generic-size {
            color: ${subText};
            font-size: 12px;
        }
        .chatlog__attachment-generic-name {
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
        }
        .chatlog__embed {
            display: flex;
            margin-top: 0.3rem;
            max-width: 520px;
        }
        .chatlog__embed-color-pill {
            flex-shrink: 0;
            width: 0.25rem;
            border-top-left-radius: 3px;
            border-bottom-left-radius: 3px;
        }
        .chatlog__embed-content-container {
            display: flex;
            flex-direction: column;
            padding: 0.5rem 0.6rem;
            border: 1px solid ${embedBorder};
            border-top-right-radius: 3px;
            border-bottom-right-radius: 3px;
            background-color: ${embedBg};
            width: 100%;
        }
        .chatlog__embed-content {
            display: flex;
            width: 100%;
        }
        .chatlog__embed-text {
            flex: 1;
        }
        .chatlog__embed-title {
            margin-bottom: 0.5rem;
            color: ${authorColor};
            font-size: 0.875rem;
            font-weight: 600;
        }
        .chatlog__embed-description {
            color: ${fg};
            font-weight: 500;
            font-size: 0.85rem;
        }
        .chatlog__embed-thumbnail {
            flex: 0;
            max-width: 80px;
            max-height: 80px;
            margin-left: 1.2rem;
            border-radius: 3px;
        }
        .chatlog__embed-images {
            display: block;
            margin-top: 0.6rem;
        }
        .chatlog__embed-image {
            object-fit: cover;
            max-width: 500px;
            max-height: 400px;
            border-radius: 3px;
        }
        .chatlog__embed-generic-image,
        .chatlog__embed-generic-gifv {
            max-width: 45vw;
            max-height: 500px;
            border-radius: 3px;
            vertical-align: top;
        }
        .chatlog__sticker {
            width: 160px;
            height: 160px;
            margin-top: 6px;
        }
        .chatlog__sticker--media {
            max-width: 100%;
            max-height: 100%;
        }
        .chatlog__reactions {
            display: flex;
            flex-wrap: wrap;
            margin-top: 4px;
        }
        .chatlog__reaction {
            display: flex;
            margin: 0.35rem 0.1rem 0.1rem 0;
            padding: 0.125rem 0.375rem;
            border: 1px solid transparent;
            border-radius: 8px;
            background-color: ${reactionBg};
            align-items: center;
        }
        .chatlog__reaction-count {
            min-width: 9px;
            margin-left: 0.35rem;
            color: ${subText};
            font-size: 0.875rem;
        }
        .chatlog__emoji {
            width: 1.325rem;
            height: 1.325rem;
            margin: 0 0.06rem;
            vertical-align: -0.4rem;
        }
        .chatlog__emoji--small {
            width: 1rem;
            height: 1rem;
        }
        .postamble {
            padding: 1.25rem;
            border-top: 1px solid ${borderCol};
            color: ${subText};
            font-size: 0.9rem;
        }
    </style>
    <script>
        function scrollToMessage(event, id) {
            const element = document.getElementById('chatlog__message-container-' + id);
            if (!element) return;
            event.preventDefault();
            element.classList.add('chatlog__message-container--highlighted');
            window.scrollTo({
                top: element.getBoundingClientRect().top - document.body.getBoundingClientRect().top - (window.innerHeight / 2),
                behavior: 'smooth'
            });
            window.setTimeout(() => element.classList.remove('chatlog__message-container--highlighted'), 2000);
        }
    </script>
</head>
<body>
<div class="preamble">
    <div class="preamble__entries-container">
        <div class="preamble__entry">#${sanitizeHtml(channelName)}</div>
        <div class="preamble__entry preamble__entry--small">Channel ID: ${channelId}</div>
    </div>
</div>
<div class="chatlog">
`;
}

function renderHtmlMessageGroup(group: MessageGroup, isDark: boolean): string {
    const authorColor = isDark ? "#ffffff" : "#2f3136";
    const subText = isDark ? "#a3a6aa" : "#5e6772";
    const embedBg = isDark ? "rgba(46, 48, 54, 0.3)" : "rgba(249, 249, 249, 0.3)";
    const embedBorder = isDark ? "rgba(46, 48, 54, 0.6)" : "rgba(204, 204, 204, 0.3)";
    const borderCol = isDark ? "rgba(255, 255, 255, 0.1)" : "#eceeef";
    const reactionBg = isDark ? "#2f3136" : "#f2f3f5";
    const fg = isDark ? "#dcddde" : "#23262a";

    const messagesHtml = group.messages.map((msg, i) => {
        const isFirst = i === 0;
        const msgDate = new Date(msg.timestamp);
        const fullTimestamp = msgDate.toLocaleString();
        const shortTimestamp = msgDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const author = msg.author?.global_name || msg.author?.username || "Unknown";
        const username = msg.author?.username || "unknown";
        const isBot = Boolean(msg.author?.bot);
        const content = formatMarkdown(msg.content);
        const isReply = Boolean(msg.referenced_message);

        const editedHtml = msg.edited_timestamp
            ? `<span class="chatlog__edited-timestamp" title="${new Date(msg.edited_timestamp).toLocaleString()}">(edited)</span>`
            : "";

        let asideHtml = "";
        if (isFirst) {
            const replySymbol = isReply ? `<div class="chatlog__reply-symbol"></div>` : "";
            asideHtml = `
            <div class="chatlog__message-aside">
                ${replySymbol}
                <img class="chatlog__avatar" src="${group.author.avatarUrl}" alt="${sanitizeHtml(username)}" loading="lazy" />
            </div>`;
        } else {
            asideHtml = `
            <div class="chatlog__message-aside">
                <div class="chatlog__short-timestamp" title="${fullTimestamp}">${shortTimestamp}</div>
            </div>`;
        }

        let replyHtml = "";
        if (isReply) {
            const ref = msg.referenced_message;
            const refAuthor = ref.author?.global_name || ref.author?.username || "Unknown";
            const refAvatar = ref.author?.avatar
                ? `https://cdn.discordapp.com/avatars/${ref.author.id}/${ref.author.avatar}.png?size=32`
                : "https://cdn.discordapp.com/embed/avatars/0.png";
            const refContent = sanitizeHtml((ref.content || "").slice(0, 140)) || "Click to see attachment";

            replyHtml = `
            <div class="chatlog__reply">
                <img class="chatlog__reply-avatar" src="${refAvatar}" alt="Avatar" loading="lazy" />
                <div class="chatlog__reply-author">${sanitizeHtml(refAuthor)}</div>
                <div class="chatlog__reply-content">
                    <span class="chatlog__reply-link" onclick="scrollToMessage(event, '${ref.id}')">${refContent}</span>
                </div>
            </div>`;
        }

        let headerHtml = "";
        if (isFirst) {
            const botTag = isBot ? `<span class="chatlog__author-tag">BOT</span>` : "";
            headerHtml = `
            <div class="chatlog__header">
                <span class="chatlog__author" title="${sanitizeHtml(username)}" data-user-id="${group.author.id}">${sanitizeHtml(author)}</span>
                ${botTag}
                <span class="chatlog__timestamp" title="${fullTimestamp}"><a href="#chatlog__message-container-${msg.id}">${fullTimestamp}</a></span>
            </div>`;
        }

        let attachmentsHtml = "";
        if (msg.attachments?.length) {
            attachmentsHtml = msg.attachments.map((att: any) => {
                const isImg = att.content_type?.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(att.filename);
                const isVid = att.content_type?.startsWith("video/") || /\.(mp4|webm|mov)$/i.test(att.filename);
                const isAudio = att.content_type?.startsWith("audio/") || /\.(mp3|ogg|wav)$/i.test(att.filename);

                if (isImg) {
                    return `
                    <div class="chatlog__attachment">
                        <a href="${att.url}" target="_blank">
                            <img class="chatlog__attachment-media" src="${att.url}" alt="${sanitizeHtml(att.filename)}" loading="lazy" />
                        </a>
                    </div>`;
                }
                if (isVid) {
                    return `
                    <div class="chatlog__attachment">
                        <video class="chatlog__attachment-media" controls>
                            <source src="${att.url}" type="${att.content_type || 'video/mp4'}" />
                        </video>
                    </div>`;
                }
                if (isAudio) {
                    return `
                    <div class="chatlog__attachment">
                        <audio class="chatlog__attachment-media" controls>
                            <source src="${att.url}" type="${att.content_type || 'audio/ogg'}" />
                        </audio>
                    </div>`;
                }
                return `
                <div class="chatlog__attachment-generic">
                    <div class="chatlog__attachment-generic-name"><a href="${att.url}" target="_blank">${sanitizeHtml(att.filename)}</a></div>
                    <div class="chatlog__attachment-generic-size">${att.size ? (att.size / 1024).toFixed(1) + ' KB' : ''}</div>
                </div>`;
            }).join("");
        }

        let stickersHtml = "";
        if (msg.sticker_items?.length) {
            stickersHtml = msg.sticker_items.map((st: any) => `
            <div class="chatlog__sticker" title="${sanitizeHtml(st.name)}">
                <img class="chatlog__sticker--media" src="https://media.discordapp.net/stickers/${st.id}.png?size=160" alt="Sticker" />
            </div>`).join("");
        }

        let embedsHtml = "";
        if (msg.embeds?.length) {
            embedsHtml = msg.embeds.map((em: any) => {
                if (em.video?.url) {
                    return `
                    <div class="chatlog__embed">
                        <video class="chatlog__embed-generic-gifv" width="${em.video.width || 400}" height="${em.video.height || 300}" autoplay loop muted playsinline controls>
                            <source src="${em.video.url}" />
                        </video>
                    </div>`;
                }

                const imgUrl = em.image?.url || em.thumbnail?.url;
                if (em.type === "image" || em.type === "gifv" || (imgUrl && !em.title && !em.description)) {
                    return `
                    <div class="chatlog__embed">
                        <a href="${imgUrl || em.url}" target="_blank">
                            <img class="chatlog__embed-generic-image" src="${imgUrl || em.url}" loading="lazy" alt="Embedded image" />
                        </a>
                    </div>`;
                }

                const title = em.title ? `<div class="chatlog__embed-title"><a href="${em.url || '#'}" target="_blank">${sanitizeHtml(em.title)}</a></div>` : "";
                const desc = em.description ? `<div class="chatlog__embed-description">${formatMarkdown(em.description)}</div>` : "";
                const color = em.color ? (em.color).toString(16).padStart(6, "0") : "202225";
                const embedImg = em.image?.url ? `<div class="chatlog__embed-images chatlog__embed-images--single"><img class="chatlog__embed-image" src="${em.image.url}" loading="lazy" /></div>` : "";
                const embedThumb = em.thumbnail?.url && !em.image?.url ? `<img class="chatlog__embed-thumbnail" src="${em.thumbnail.url}" loading="lazy" />` : "";

                return `
                <div class="chatlog__embed">
                    <div class="chatlog__embed-color-pill" style="background-color: #${color};"></div>
                    <div class="chatlog__embed-content-container">
                        <div class="chatlog__embed-content">
                            <div class="chatlog__embed-text">
                                ${title}
                                ${desc}
                                ${embedImg}
                            </div>
                            ${embedThumb}
                        </div>
                    </div>
                </div>`;
            }).join("");
        }

        let reactionsHtml = "";
        if (msg.reactions?.length) {
            reactionsHtml = `
            <div class="chatlog__reactions">` +
                msg.reactions.map((r: any) => {
                    const emojiUrl = r.emoji?.id ? `https://cdn.discordapp.com/emojis/${r.emoji.id}.png?size=32` : null;
                    const emojiElem = emojiUrl
                        ? `<img class="chatlog__emoji chatlog__emoji--small" src="${emojiUrl}" alt="${sanitizeHtml(r.emoji.name)}" />`
                        : `<span>${r.emoji?.name || "👍"}</span>`;
                    return `
                    <div class="chatlog__reaction">
                        ${emojiElem}
                        <span class="chatlog__reaction-count">${r.count}</span>
                    </div>`;
                }).join("") +
            `</div>`;
        }

        return `
        <div id="chatlog__message-container-${msg.id}" class="chatlog__message-container" data-message-id="${msg.id}">
            <div class="chatlog__message">
                ${asideHtml}
                <div class="chatlog__message-primary">
                    ${replyHtml}
                    ${headerHtml}
                    ${content ? `<div class="chatlog__content chatlog__markdown"><span class="chatlog__markdown-preserve">${content}</span>${editedHtml}</div>` : ""}
                    ${attachmentsHtml}
                    ${stickersHtml}
                    ${embedsHtml}
                    ${reactionsHtml}
                </div>
            </div>
        </div>`;
    }).join("");

    return `
    <div class="chatlog__message-group">
        ${messagesHtml}
    </div>`;
}

function renderHtmlFooter(totalCount: number): string {
    return `
</div>
<div class="postamble">
    Exported ${totalCount.toLocaleString()} messages • ${new Date().toLocaleString()}
</div>
</body>
</html>`;
}

async function exportChannelStreaming(
    channel: Channel,
    options: ExportOptions,
    writer: StreamWriter,
    abortSignal: AbortSignal,
    onProgress: (progress: ExportProgress) => void
): Promise<number> {
    const channelName = getChannelDisplayName(channel);
    const isDark = options.format !== "HtmlLight";
    const FLUSH_THRESHOLD = 20000;
    let totalMessagesExported = 0;
    let isFirstBatch = true;
    let writeBuffer: any[] = [];

    // 1. Write Header
    if (options.format === "HtmlDark" || options.format === "HtmlLight") {
        await writer.write(renderHtmlHeader(channelName, channel.id, isDark));
    } else if (options.format === "Json") {
        await writer.write(`{\n  "channel": ${JSON.stringify({ id: channel.id, name: channelName })},\n  "messages": [\n`);
    } else if (options.format === "Csv") {
        await writer.write("MessageID,AuthorID,Author,Date,Content,Attachments,Reactions,Stickers,ReplyTo\n");
    } else if (options.format === "PlainText") {
        await writer.write(`====================================================\nChannel: ${channelName} (${channel.id})\nExport Date: ${new Date().toLocaleString()}\n====================================================\n\n`);
    }

    const flushDiskBuffer = async () => {
        if (writeBuffer.length === 0) return;

        if (options.format === "HtmlDark" || options.format === "HtmlLight") {
            const groups = groupMessages(writeBuffer);
            const chunkHtml = groups.map(g => renderHtmlMessageGroup(g, isDark)).join("\n");
            await writer.write(chunkHtml);
        } else if (options.format === "Json") {
            const jsonRows = writeBuffer.map(msg => `    ${JSON.stringify(msg)}`).join(",\n");
            await writer.write((isFirstBatch ? "" : ",\n") + jsonRows);
        } else if (options.format === "Csv") {
            const csvRows = writeBuffer.map(msg => {
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
            }).join("\n") + "\n";
            await writer.write(csvRows);
        } else if (options.format === "PlainText") {
            const textRows = writeBuffer.map(msg => {
                const author = msg.author?.global_name || msg.author?.username || "Unknown";
                const date = new Date(msg.timestamp).toISOString().replace("T", " ").substring(0, 19);
                let text = `[${date}] ${author}: ${msg.content || ""}`;
                if (msg.attachments?.length) {
                    text += `\n  [Attachments: ${msg.attachments.map((a: any) => a.url).join(", ")}]`;
                }
                return text;
            }).join("\n") + "\n";
            await writer.write(textRows);
        }

        isFirstBatch = false;
        writeBuffer = [];
    };

    const beforeSnowflake = options.beforeDate ? dateToSnowflake(new Date(options.beforeDate)) : undefined;
    const afterSnowflake = options.afterDate ? dateToSnowflake(new Date(options.afterDate)) : undefined;
    const maxCount = options.maxMessages && options.maxMessages > 0 ? options.maxMessages : Infinity;
    const isReverse = Boolean(options.reverseOrder);
    const respectRateLimits = options.respectRateLimits !== false;

    if (abortSignal.aborted) throw { isCanceled: true };

    let omegaTimestamp: number | null = null;
    try {
        const omegaRes = await fetchBatch(channel.id, { limit: 1, ...(beforeSnowflake ? { before: beforeSnowflake } : {}) }, abortSignal);
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

    let pendingFetch: Promise<any> | null = fetchBatch(channel.id, buildQuery(currentBoundary, maxCount - totalMessagesExported), abortSignal);

    while (totalMessagesExported < maxCount) {
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
            const countAfterThis = totalMessagesExported + messages.length;
            const hasMore = messages.length === 100 && countAfterThis < maxCount;

            if (hasMore && !abortSignal.aborted) {
                pendingFetch = fetchBatch(channel.id, buildQuery(nextBoundary, maxCount - countAfterThis), abortSignal);
            } else {
                pendingFetch = null;
            }

            const batchToAdd: any[] = [];
            for (const msg of messages) {
                if (!isReverse && beforeSnowflake && BigInt(msg.id) >= BigInt(beforeSnowflake)) {
                    break;
                }
                if (isReverse && afterSnowflake && BigInt(msg.id) <= BigInt(afterSnowflake)) {
                    break;
                }
                if (!options.includeBotMessages && msg.author?.bot) continue;
                batchToAdd.push(msg);
                if (totalMessagesExported + batchToAdd.length >= maxCount) break;
            }

            if (batchToAdd.length > 0) {
                writeBuffer.push(...batchToAdd);
                totalMessagesExported += batchToAdd.length;

                if (writeBuffer.length >= FLUSH_THRESHOLD) {
                    await flushDiskBuffer();
                }
            }

            const now = Date.now();
            if (now - lastProgressUpdate > 100 || totalMessagesExported >= maxCount) {
                const elapsedSec = Math.max(0.1, (now - startTime) / 1000);
                const rate = Math.round(totalMessagesExported / elapsedSec);

                let fraction = 0;
                if (maxCount !== Infinity && maxCount > 0) {
                    fraction = Math.min(1, totalMessagesExported / maxCount);
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
                    count: totalMessagesExported,
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
                pendingFetch = fetchBatch(channel.id, buildQuery(currentBoundary, maxCount - totalMessagesExported), abortSignal);
                continue;
            }
            throw err;
        }
    }

    if (writeBuffer.length > 0) {
        await flushDiskBuffer();
    }

    if (options.format === "HtmlDark" || options.format === "HtmlLight") {
        await writer.write(renderHtmlFooter(totalMessagesExported));
    } else if (options.format === "Json") {
        await writer.write(`\n  ],\n  "messageCount": ${totalMessagesExported}\n}\n`);
    }
    await writer.close();

    return totalMessagesExported;
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
        const safeName = channelName.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
        const dateStr = new Date().toISOString().substring(0, 10);
        const ext = format === "Json" ? "json" : format === "Csv" ? "csv" : format === "PlainText" ? "txt" : "html";
        const filename = `${safeName}_${dateStr}.${ext}`;

        let writer: StreamWriter;
        try {
            // Prompt user for save destination BEFORE starting export
            writer = await createStreamWriter(filename, format);
        } catch (e: any) {
            if (e?.isCanceled) return;
            console.error("[ChatExporter] Save picker canceled:", e);
            return;
        }

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
            const count = await exportChannelStreaming(
                channel,
                {
                    format,
                    afterDate: afterDate || undefined,
                    beforeDate: beforeDate || undefined,
                    maxMessages: maxMessages ? parseInt(maxMessages, 10) : undefined,
                    includeBotMessages: includeBots,
                    respectRateLimits: !hyperSpeed,
                },
                writer,
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

            showToast(`Exported ${count.toLocaleString()} messages successfully!`, Toasts.Type.SUCCESS);
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
                    text: "Save & Export",
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
