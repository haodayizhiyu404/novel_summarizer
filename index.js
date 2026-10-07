const extensionName = 'novel-summarizer';

// 旧版默认模板（v1.0.0），用于自动升级已保存的设置
const OLD_DEFAULT_PROMPT = [
    '# 特殊指令：大总结（剧情编年史）',
    '请对前文所有已发生事实、因果关系及人物关系演变生成一份深度留档，作为故事的历史记录。所有的总结必须基于故事内的当前时间点（如：截至X年X月X日）。',
].join('\n');

const defaultSettings = {
    enabled: true,
    autoTrigger: false,
    chunkSize: 50,
    keepRecent: 10,
    firstTrigger: 60,
    summaryTag: 'summary',
    targetLength: 20000,
    maxBatchSize: 200,
    injectionLabel: '历史剧情',
    useCustomApi: false,
    customBaseUrl: '',
    customApiKey: '',
    customModel: '',
    includeCharInfo: true,
    includeWorldInfo: true,
    promptTemplate:
`# 你的身份：小说总结引擎
#唯一任务：总结所有已发生故事内容（剧情编年史）
请对前文剧情中所有已发生事实、因果关系及人物关系演变生成一份深度留档，作为故事的历史记录。所有的总结必须基于故事内的当前时间点（如：截至X年X月X日）。

## 格式

\`\`\`
## 故事演进脉络
首先标注清楚**截止到剧情内xx时间点**。用2-3句话概括从故事开局至当前时间点的整体走向。说明发生了什么根本性的变化，以及目前主角面临的核心处境是什么。不要只写眼下的瞬时状态，要体现出故事的推移。

## 核心事件编年史
按时间顺序列出有价值的、改变剧情走向或人物命运的关键事件。
不要只写出干瘪的结果（如“A和B离婚”）。必须保留事件的关键信息，比如：背景压力、心理动机、重大抉择和最终结果等（例如：“迫于事业危机与家族的强制介入，B在权衡再三后，为了保护A而忍痛选择与A离婚”）。
- [时间] 事件1（包含动机、因果与结果）
- [时间] 事件2（包含动机、因果与结果）

## 人物关系与演变档案
只记录与{{user}}有持续重大交互的NPC。禁止流水账，重点记录深层羁绊和矛盾：
- [NPC名]：身份/在故事中的核心定位
  - 人格底色：TA在故事中展现出的最真实的性格内核与软肋。
  - 关系演变：简述和{{user}}的关系是如何从最初走到现在的，有何重要变更节点。
  - 当前关系状态与深层态度：目前双方表面上处于什么关系？该NPC内心对{{user}}的真实态度是什么？
  - 未决事项：两人之间目前横亘的最大阻碍、未解开的秘密或尚未兑现的承诺。

## 遗留线索
只记录对后续剧情仍有明确限制或影响的关键信息（例如：{{user}}失去了一笔重要资金、某反派仍在暗中监视、A的身体留下了某种不可逆的旧伤等）。不写无意义的环境状态。随着时间过去，不再重要的信息及时剔除。
\`\`\`

## 规则
- 以内容完整度为第一要求，字数不做限制，禁止过度压缩丢失信息。
- 优先保存剧情张力与因果逻辑，闲聊可以不写，但“为什么做下某个重大决定”必须写清楚。
- 不要预测未来，所有记录严格基于当前故事时间点已发生的事实。
- 措辞客观，避免浮夸，杜绝"神明"、"病态"、"极度"、"自毁"等激烈、极端的词汇。

## 前文所有剧情（不得遗漏，必须对此进行压缩，同步整合进完整总结内容中）：
{{剧情档案}}`,
    finalUserPrompt: '请基于以上剧情生成大总结。',
    missingSummaryAction: 'skip', // 'skip' | 'raw' | 'placeholder'
};

const defaultMeta = {
    bigSummary: '',
    nextTriggerFloor: defaultSettings.firstTrigger,
    lastSummarizedMessageIndex: -1,
    isSummarizing: false,
    history: [],
};

let lastDebugMessage = '初始化中...';

function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function logDebug(msg) {
    lastDebugMessage = `[${new Date().toLocaleTimeString()}] ${msg}`;
    console.log(`[${extensionName}]`, msg);
    $(`#${extensionName}-debug-log`).text(lastDebugMessage);
}

function getSettings(context) {
    const settings = context.extensionSettings;
    if (!settings) return null;
    if (!settings[extensionName]) {
        settings[extensionName] = deepClone(defaultSettings);
        context.saveSettingsDebounced();
    } else {
        let changed = false;
        for (const key of Object.keys(defaultSettings)) {
            if (settings[extensionName][key] === undefined) {
                settings[extensionName][key] = defaultSettings[key];
                changed = true;
            }
        }
        if (changed) context.saveSettingsDebounced();
    }
    // 模板默认值升级：如果用户保存的还是旧版默认模板，自动替换为新版
    if (settings[extensionName].promptTemplate && settings[extensionName].promptTemplate.startsWith(OLD_DEFAULT_PROMPT)) {
        settings[extensionName].promptTemplate = defaultSettings.promptTemplate;
        context.saveSettingsDebounced();
    }
    // 旧默认值 500 升级为 20000（仅当用户没改过、仍是旧默认时）
    if (settings[extensionName].targetLength === 500) {
        settings[extensionName].targetLength = defaultSettings.targetLength;
        context.saveSettingsDebounced();
    }
    return settings[extensionName];
}

function getMeta(context) {
    // 每次重新拿 context，避免 chat_metadata 被 ST 重新赋值后引用失效
    const freshContext = SillyTavern.getContext();
    const meta = freshContext.chatMetadata;
    if (!meta) return null;

    if (!meta[extensionName]) {
        meta[extensionName] = deepClone(defaultMeta);
        meta[extensionName].nextTriggerFloor = getSettings(freshContext)?.firstTrigger ?? defaultSettings.firstTrigger;
        freshContext.updateChatMetadata({ [extensionName]: meta[extensionName] });
        freshContext.saveMetadataDebounced();
    } else {
        for (const key of Object.keys(defaultMeta)) {
            if (meta[extensionName][key] === undefined) {
                meta[extensionName][key] = defaultMeta[key];
            }
        }
        delete meta[extensionName].aiMessageCount;
        delete meta[extensionName].lastSummarizedOriginalAiIndex;
        freshContext.updateChatMetadata({ [extensionName]: meta[extensionName] });
        freshContext.saveMetadataDebounced();
    }
    return meta[extensionName];
}

function isSummarizableMessage(msg) {
    return !!msg && !msg.is_user;
}

function extractSummary(text, tag) {
    const regex = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const match = text.match(regex);
    return match ? match[1].trim() : '';
}

// 支持多标签：用逗号/空格/中文逗号分隔，按顺序逐个尝试，取第一个命中的
function parseSummaryTags(settings) {
    return String(settings?.summaryTag || 'summary')
        .split(/[,，;；\s]+/)
        .map(t => t.trim())
        .filter(Boolean);
}

function extractAnySummary(text, tags) {
    for (const tag of tags) {
        const s = extractSummary(text, tag);
        if (s) return s;
    }
    return '';
}

function getAvailableSummaries(context, upToIndex = null) {
    const settings = getSettings(context);
    const chat = context.chat;
    if (!chat || !settings) return [];

    const tags = parseSummaryTags(settings);
    const result = [];
    const end = upToIndex === null ? chat.length - 1 : Math.min(upToIndex, chat.length - 1);
    for (let i = 0; i <= end; i++) {
        const msg = chat[i];
        if (!isSummarizableMessage(msg)) continue;
        const s = extractAnySummary(msg.mes, tags);
        if (s) result.push({ index: i, summary: s });
    }
    return result;
}

function scanSummaryTags(context) {
    const chat = context.chat;
    if (!chat || chat.length === 0) return null;

    const candidates = ['abstract', 'summary', 'synopsis', 'recap', 'plot'];
    const counts = {};
    const firstHits = {};
    for (const tag of candidates) {
        counts[tag] = 0;
        firstHits[tag] = -1;
    }

    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];
        if (!msg || msg.is_user) continue;
        const text = String(msg.mes || '');
        for (const tag of candidates) {
            if (extractSummary(text, tag)) {
                counts[tag]++;
                if (firstHits[tag] === -1) firstHits[tag] = i;
            }
        }
    }

    const hits = Object.entries(counts)
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1]);

    return { hits, firstHits, totalAiMessages: chat.filter(m => m && !m.is_user).length };
}

function stripThinkingTags(text) {
    return String(text || '')
        .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
        .replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, '')
        .trim();
}

function buildPrompt(settings, bigSummary, newSummaries, context = null) {
    const freshContext = context || SillyTavern.getContext();
    const userName = freshContext?.name1 || 'User';
    const charName = freshContext?.name2 || 'Character';

    const summariesText = newSummaries
        .map((s, i) => `${i + 1}. ${s}`)
        .join('\n');

    const existingPlot = (bigSummary || '').trim();
    const newPlot = summariesText.trim();

    let archive = '';
    if (existingPlot) {
        archive += existingPlot;
    }
    if (newPlot) {
        if (archive) archive += '\n\n';
        archive += newPlot;
    }

    let prompt = settings.promptTemplate
        .replace(/\{\{剧情档案\}\}/g, archive)
        .replace(/\{\{已有剧情\}\}/g, existingPlot)
        .replace(/\{\{新增剧情\}\}/g, newPlot)
        .replace(/\{\{BIG_SUMMARY\}\}/g, existingPlot)
        .replace(/\{\{NEW_SUMMARIES\}\}/g, newPlot)
        .replace(/\{\{user\}\}/g, userName)
        .replace(/\{\{char\}\}/g, charName);

    // 如果用户把所有占位符都删了，自动追加剧情档案到末尾
    if (!/\{\{(剧情档案|已有剧情|新增剧情|BIG_SUMMARY|NEW_SUMMARIES)\}\}/.test(settings.promptTemplate)) {
        if (archive) prompt += '\n\n' + archive;
    }

    return prompt;
}

// 角色卡设定块：让总结 AI 知道主角人设，避免冷门 NPC 被理解偏差
function buildCharInfoBlock(context, userName, charName) {
    const char = context?.characters?.[context.characterId];
    if (!char) return '';
    const fill = (t) => String(t || '')
        .replace(/\{\{user\}\}/gi, userName)
        .replace(/\{\{char\}\}/gi, charName)
        .trim();
    const parts = [];
    if (fill(char.description)) parts.push(`【${charName} 的角色卡设定】\n${fill(char.description)}`);
    if (fill(char.personality)) parts.push(`【${charName} 的性格设定】\n${fill(char.personality)}`);
    if (fill(char.scenario)) parts.push(`【故事背景情境】\n${fill(char.scenario)}`);
    return parts.join('\n\n');
}

// 世界书块：取当前激活的 World Info 条目作为背景参考
// 注意：context.getWorldInfoPrompt 是【异步函数】，返回 { worldInfoString, ... } 对象
async function buildWorldInfoBlock(context) {
    if (typeof context?.getWorldInfoPrompt !== 'function') return '';
    try {
        // 注意：getWorldInfoPrompt 要求传入【字符串数组】（最新消息在前），
        // 与 ST 主流程一致：chat.map(x => `${x.name}: ${x.mes}`).reverse()
        const chatForWI = (context.chat || [])
            .map(x => `${x.name}: ${x.mes}`)
            .reverse();
        const result = await context.getWorldInfoPrompt(chatForWI, 4096, true);
        const text = String(result?.worldInfoString || '').trim();
        if (!text) return '';
        logDebug(`已注入 World Info 背景，长度 ${text.length} 字符`);
        return `【World Info 世界书条目（仅作背景参考，不要总结此部分内容）】\n${text}`;
    } catch (err) {
        console.warn(`[${extensionName}] 获取 World Info 失败`, err);
        return '';
    }
}

async function buildMessages(settings, bigSummary, historyMessages, context) {
    const userName = context?.name1 || 'User';
    const charName = context?.name2 || 'Character';

    // system 消息：总结指令 + 已有大总结
    const systemContent = buildPrompt(settings, bigSummary, [], context);

    // 背景信息：角色卡设定 + 世界书（可分别关闭）
    const bg = [];
    if (settings.includeCharInfo !== false) {
        const charBlock = buildCharInfoBlock(context, userName, charName);
        if (charBlock) {
            bg.push(charBlock);
            logDebug(`已注入角色卡设定，长度 ${charBlock.length} 字符`);
        }
    }
    if (settings.includeWorldInfo !== false) {
        const wiBlock = await buildWorldInfoBlock(context);
        if (wiBlock) bg.push(wiBlock);
    }

    const identity = `User 名称：${userName}。以下对话中，user 代表 User，assistant 代表故事角色（可能包含多位 NPC）。\n\n`;

    const messages = [
        { role: 'system', content: identity + (bg.length ? bg.join('\n\n') + '\n\n' : '') + systemContent },
        ...historyMessages,
        { role: 'user', content: settings.finalUserPrompt || '请基于以上剧情生成大总结。' },
    ];
    return messages;
}

async function generateWithCustomApi(context, messages) {
    const settings = getSettings(context);
    if (!settings) throw new Error('设置为空');

    const baseUrl = String(settings.customBaseUrl || '').trim().replace(/\/$/, '');
    const apiKey = String(settings.customApiKey || '').trim();
    const model = String(settings.customModel || '').trim();

    if (!baseUrl) throw new Error('未填写自定义 API Base URL');
    if (!apiKey) throw new Error('未填写自定义 API Key');
    if (!model) throw new Error('未填写自定义模型名');

    const url = `${baseUrl}/chat/completions`;
    logDebug(`请求自定义 API：${url}，模型：${model}`);

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: model,
            messages: messages,
            max_tokens: settings.targetLength,
            temperature: 0.5,
            stream: false,
        }),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`API 请求失败 ${response.status}：${errText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
        throw new Error('API 返回中没有 choices[0].message.content');
    }
    return content;
}

async function fetchCustomModels(context) {
    const settings = getSettings(context);
    const baseUrl = String(settings?.customBaseUrl || '').trim().replace(/\/$/, '');
    const apiKey = String(settings?.customApiKey || '').trim();

    if (!baseUrl) throw new Error('未填写自定义 API Base URL');

    const url = `${baseUrl}/models`;
    logDebug(`拉取模型列表：${url}`);

    const response = await fetch(url, {
        method: 'GET',
        headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {},
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`拉取模型列表失败 ${response.status}：${errText}`);
    }

    const data = await response.json();
    return data.data?.map(m => m.id).filter(Boolean) || [];
}

async function hideOldMessages(context, lastIncludedMessageIndex) {
    const settings = getSettings(context);
    const keepRecent = settings?.keepRecent ?? defaultSettings.keepRecent;
    const firstKeptMessageIndex = lastIncludedMessageIndex + 1;
    const chat = context.chat;
    if (!chat || chat.length === 0) return;
    if (firstKeptMessageIndex <= 0) return;

    logDebug(`隐藏 #0~#${firstKeptMessageIndex - 1} 的消息（is_system）`);
    for (let i = 0; i < firstKeptMessageIndex && i < chat.length; i++) {
        chat[i].is_system = true;
    }

    for (let i = 0; i < firstKeptMessageIndex; i++) {
        $(`.mes[mesid="${i}"]`).attr('is_system', 'true');
    }

    await context.saveChat();
}

function alignMetaWithHidden(context) {
    const meta = getMeta(context);
    const chat = context.chat;
    if (!meta || !chat || chat.length === 0) return;

    const startIndex = meta.lastSummarizedMessageIndex + 1;
    let firstVisibleIndex = -1;
    for (let i = startIndex; i < chat.length; i++) {
        if (chat[i] && !chat[i].is_system) {
            firstVisibleIndex = i;
            break;
        }
    }

    if (firstVisibleIndex > startIndex) {
        const skippedCount = firstVisibleIndex - startIndex;
        meta.lastSummarizedMessageIndex = firstVisibleIndex - 1;
        context.updateChatMetadata({ [extensionName]: meta });
        context.saveMetadataDebounced();
        logDebug(`对齐已隐藏楼层：跳过 ${skippedCount} 条隐藏消息，已总结到 #${meta.lastSummarizedMessageIndex}`);
    }
}

async function runSummarization(context, forcedTargetFloor = null) {
    const settings = getSettings(context);
    const meta = getMeta(context);
    if (!settings || !meta) {
        logDebug('错误：settings 或 meta 为空');
        return;
    }
    if (meta.isSummarizing) {
        logDebug('跳过：正在总结中');
        return;
    }

    const chat = context.chat;
    if (!chat || chat.length === 0) {
        logDebug('错误：当前没有聊天记录');
        return;
    }

    const messageCount = chat.length;
    const targetFloor = forcedTargetFloor ?? meta.nextTriggerFloor;
    const keepRecent = settings.keepRecent ?? defaultSettings.keepRecent;
    const maxBatchSize = settings.maxBatchSize ?? defaultSettings.maxBatchSize;

    // 让 lastSummarizedMessageIndex 与已隐藏的楼层对齐：
    // 手动隐藏的消息也视为“已经处理过”，不再回头扫描。
    alignMetaWithHidden(context);
    const startIndex = meta.lastSummarizedMessageIndex + 1;
    if (startIndex >= chat.length) {
        logDebug('没有新的可见消息需要总结');
        if (forcedTargetFloor) {
            toastr.info('没有新的前文需要总结');
        }
        updateUi(context);
        return;
    }

    // 计算本次要处理的可见消息范围（跳过 is_system 的隐藏消息）
    const visibleIndexes = [];
    for (let i = startIndex; i < chat.length; i++) {
        if (!chat[i] || chat[i].is_system) continue;
        visibleIndexes.push(i);
    }
    const totalVisible = visibleIndexes.length;
    const availableToProcess = Math.max(0, totalVisible - keepRecent);
    const toIncludeCount = Math.min(maxBatchSize, availableToProcess);
    const lastMsgIndexToInclude = toIncludeCount > 0 ? visibleIndexes[toIncludeCount - 1] : startIndex - 1;

    if (availableToProcess > maxBatchSize) {
        logDebug(`未总结消息过多，本次仅压缩前 ${maxBatchSize} 条可见消息`);
        toastr.info(`未总结消息过多，本次仅压缩前 ${maxBatchSize} 条`);
    }

    logDebug(`开始总结：总消息 ${messageCount}，目标楼层 ${targetFloor}，准备压缩到 #${lastMsgIndexToInclude}，已压缩到 #${meta.lastSummarizedMessageIndex}，本轮可见消息 ${toIncludeCount}/${totalVisible}`);

    if (lastMsgIndexToInclude < startIndex) {
        logDebug('没有新的可见消息需要总结');
        if (forcedTargetFloor) {
            toastr.info('没有新的前文需要总结');
        }
        return;
    }

    const newSummaries = [];
    const historyMessages = [];
    const missingAction = settings.missingSummaryAction || 'skip';
    const summaryTags = parseSummaryTags(settings);
    for (let i = startIndex; i <= lastMsgIndexToInclude && i < chat.length; i++) {
        const msg = chat[i];
        if (!msg || msg.is_system) continue;

        if (msg.is_user) {
            const content = stripThinkingTags(msg.mes);
            if (content) {
                historyMessages.push({ role: 'user', content });
            }
        } else {
            const summary = extractAnySummary(msg.mes, summaryTags);
            if (summary) {
                historyMessages.push({ role: 'assistant', content: summary });
                newSummaries.push(summary);
            } else {
                if (missingAction === 'raw') {
                    const content = stripThinkingTags(msg.mes);
                    if (content) {
                        historyMessages.push({ role: 'assistant', content });
                    }
                } else if (missingAction === 'placeholder') {
                    historyMessages.push({ role: 'assistant', content: `[本轮 assistant 未提供摘要标签（${summaryTags.map(t => '<' + t + '>').join('/')}）内容]` });
                }
                // 'skip'：直接忽略该轮 assistant
            }
        }
    }

    logDebug(`找到 ${newSummaries.length} 条新的 summary，历史消息 ${historyMessages.length} 条`);

    if (newSummaries.length === 0 && missingAction !== 'raw') {
        logDebug('未找到任何摘要标签内容，跳过本次压缩');
        toastr.error('未找到任何摘要标签内容，请检查标签名是否正确（支持填多个，用逗号分隔）');
        updateUi(context);
        return;
    }

    if (historyMessages.length === 0) {
        logDebug('没有可用的历史消息用于总结');
        toastr.error('没有可用的历史消息用于总结');
        updateUi(context);
        return;
    }

    meta.isSummarizing = true;
    updateUi(context);
    toastr.info(`Novel Summarizer：正在压缩到 #${lastMsgIndexToInclude}...`);
    logDebug(`调用 generateRaw，主 API：${context.mainApi}，目标长度 ${settings.targetLength}`);

    try {
        const messages = await buildMessages(settings, meta.bigSummary, historyMessages, context);
        const totalChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
        logDebug(`提示词已构造，共 ${messages.length} 条消息，总字符 ${totalChars}`);

        let result;
        window.__lastMessageRoleGuardPause = true;
        try {
            if (settings.useCustomApi) {
                result = await generateWithCustomApi(context, messages);
            } else {
                result = await context.generateRaw({
                    prompt: messages,
                    api: context.mainApi,
                    responseLength: settings.targetLength,
                });
            }
        } finally {
            window.__lastMessageRoleGuardPause = false;
        }

        logDebug(`生成返回，长度 ${result?.length ?? 0}`);

        if (!result || !result.trim()) {
            throw new Error('AI 返回了空总结');
        }

        meta.history = meta.history || [];
        meta.history.push({
            lastSummarizedMessageIndex: meta.lastSummarizedMessageIndex,
            bigSummary: meta.bigSummary,
            nextTriggerFloor: meta.nextTriggerFloor,
            at: new Date().toISOString(),
        });
        if (meta.history.length > 20) {
            meta.history = meta.history.slice(-20);
        }

        meta.bigSummary = result.trim();
        meta.lastSummarizedMessageIndex = lastMsgIndexToInclude;
        meta.nextTriggerFloor = lastMsgIndexToInclude + 1 + settings.chunkSize;
        logDebug(`保存前 bigSummary 长度：${meta.bigSummary.length}`);
        if (typeof context.updateChatMetadata !== 'function' || typeof context.saveMetadata !== 'function') {
            logDebug('警告：context.updateChatMetadata 或 saveMetadata 不可用');
        } else {
            context.updateChatMetadata({ [extensionName]: meta });
            await context.saveMetadata();
            logDebug('已调用 updateChatMetadata + saveMetadata');
        }
        context.saveMetadataDebounced();

        await hideOldMessages(context, lastMsgIndexToInclude);

        toastr.success(`Novel Summarizer：已生成前文总结（覆盖到 #${lastMsgIndexToInclude}）`);
        logDebug('总结成功并已保存');
        injectBigSummary(context);
    } catch (err) {
        console.error(`[${extensionName}] 总结失败`, err);
        logDebug(`总结失败：${err.message || err}`);
        toastr.error(`Novel Summarizer：总结失败 - ${err.message || err}`);
    } finally {
        meta.isSummarizing = false;
        updateUi(context);
    }
}

async function resetAndResummarize(context) {
    const meta = getMeta(context);
    if (!meta) return;
    if (meta.isSummarizing) {
        toastr.warning('正在总结中，请稍后再试');
        return;
    }

    logDebug('用户要求重新总结，清空已有大总结');
    meta.bigSummary = '';
    meta.lastSummarizedMessageIndex = -1;
    meta.nextTriggerFloor = getSettings(context)?.firstTrigger ?? defaultSettings.firstTrigger;
    context.updateChatMetadata({ [extensionName]: meta });
    await context.saveMetadata();
    context.saveMetadataDebounced();

    const messageCount = context.chat?.length ?? 0;
    if (messageCount > 0) {
        await runSummarization(context, messageCount);
    }
}

async function clearAllSummaries(context) {
    const meta = getMeta(context);
    if (!meta) return;
    if (meta.isSummarizing) {
        toastr.warning('正在总结中，请稍后再试');
        return;
    }

    logDebug('清空所有总结');
    meta.bigSummary = '';
    meta.lastSummarizedMessageIndex = -1;
    meta.nextTriggerFloor = getSettings(context)?.firstTrigger ?? defaultSettings.firstTrigger;
    meta.history = [];
    context.updateChatMetadata({ [extensionName]: meta });
    await context.saveMetadata();
    context.saveMetadataDebounced();

    await unhideMessagesAfter(context, -1);

    injectBigSummary(context);
    updateUi(context);
    toastr.success('已清空所有总结并恢复所有隐藏消息');
}

async function unhideMessagesAfter(context, index) {
    const chat = context.chat;
    if (!chat || chat.length === 0) return;
    let count = 0;
    for (let i = index + 1; i < chat.length; i++) {
        if (chat[i].is_system) {
            chat[i].is_system = false;
            $(`.mes[mesid="${i}"]`).attr('is_system', 'false');
            count++;
        }
    }
    if (count > 0) {
        logDebug(`撤销隐藏：已恢复 ${count} 条 #${index + 1} 之后的消息`);
        await context.saveChat();
    }
}

async function undoLastSummarization(context) {
    const meta = getMeta(context);
    if (!meta) return;
    if (!meta.history || meta.history.length === 0) {
        toastr.warning('没有可撤销的历史版本');
        return;
    }
    if (meta.isSummarizing) {
        toastr.warning('正在总结中，请稍后再试');
        return;
    }

    const checkpoint = meta.history.pop();
    logDebug(`撤销到历史版本：已总结到 #${checkpoint.lastSummarizedMessageIndex}`);
    meta.bigSummary = checkpoint.bigSummary;
    meta.lastSummarizedMessageIndex = checkpoint.lastSummarizedMessageIndex;
    meta.nextTriggerFloor = checkpoint.nextTriggerFloor;
    context.updateChatMetadata({ [extensionName]: meta });
    await context.saveMetadata();
    await unhideMessagesAfter(context, checkpoint.lastSummarizedMessageIndex);
    updateUi(context);
    toastr.success(`已撤销上次总结，恢复到 #0~#${checkpoint.lastSummarizedMessageIndex}`);
}

async function checkAndRunTriggers(context) {
    const settings = getSettings(context);
    const meta = getMeta(context);
    if (!settings || !meta) return;
    if (!settings.enabled || !settings.autoTrigger || meta.isSummarizing) return;

    const messageCount = context.chat?.length ?? 0;
    while (messageCount >= meta.nextTriggerFloor) {
        logDebug(`自动触发：当前 ${messageCount} ≥ ${meta.nextTriggerFloor}`);
        await runSummarization(context);
        if (meta.isSummarizing) break;
    }
}

function injectBigSummary(context) {
    const settings = getSettings(context);
    const meta = getMeta(context);
    if (!settings || !meta) return;

    if (settings.enabled && meta.bigSummary) {
        const label = (settings.injectionLabel || '历史剧情').trim();
        context.setExtensionPrompt(
            extensionName,
            `${label}\n${meta.bigSummary}`,
            1,      // IN_CHAT：插入到聊天记录序列中，而不是主提示词区域
            9999,   // 深度 9999 = 放在聊天记录最顶部
            false,  // 不参与 WI 扫描
            0,      // SYSTEM
        );
        logDebug(`大总结已以系统消息形式注入聊天记录顶部，标签：${label}`);
    } else {
        context.setExtensionPrompt(extensionName, '', 1, 9999, false, 0);
    }
}

function onChatChanged(context) {
    logDebug('chatMetadata 中保存的数据：' + JSON.stringify(context.chatMetadata?.[extensionName]));
    alignMetaWithHidden(context);
    injectBigSummary(context);
    updateUi(context);
}

function onGenerationAfterCommands(context) {
    injectBigSummary(context);
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function addSettingsPanel(context) {
    const settings = getSettings(context);
    if (!settings) return;

    const html = `
        <div class="inline-drawer wide100p" id="${extensionName}-settings">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>小说总结器 (Novel Summarizer)</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="flex-container flexFlowColumn gap5">
                    <label for="${extensionName}-enabled" class="checkbox_label">
                        <input id="${extensionName}-enabled" type="checkbox" class="checkbox" ${settings.enabled ? 'checked' : ''} />
                        <span>启用大总结注入</span>
                    </label>
                </div>
                <div class="flex-container flexFlowColumn gap5">
                    <label for="${extensionName}-auto-trigger" class="checkbox_label">
                        <input id="${extensionName}-auto-trigger" type="checkbox" class="checkbox" ${settings.autoTrigger ? 'checked' : ''} />
                        <span>到达楼层时自动总结</span>
                    </label>
                </div>

                <div class="inline-drawer wide100p">
                    <div class="inline-drawer-toggle inline-drawer-header">
                        <b>高级配置（触发条件、标签、模型、API）</b>
                        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                    </div>
                    <div class="inline-drawer-content">
                <div class="flex-container flexFlowColumn gap5">
                    <label for="${extensionName}-chunk-size">每 N 条总消息触发一次总结：</label>
                    <input id="${extensionName}-chunk-size" type="number" class="text_pole" min="1" value="${settings.chunkSize}" />
                </div>
                <div class="flex-container flexFlowColumn gap5">
                    <label for="${extensionName}-keep-recent">保留最近 N 条总消息不总结：</label>
                    <input id="${extensionName}-keep-recent" type="number" class="text_pole" min="0" value="${settings.keepRecent}" />
                </div>
                <div class="flex-container flexFlowColumn gap5">
                    <label for="${extensionName}-first-trigger">首次触发总消息数（通常 = 间隔 + 保留）：</label>
                    <input id="${extensionName}-first-trigger" type="number" class="text_pole" min="1" value="${settings.firstTrigger}" />
                </div>
                <div class="flex-container flexFlowColumn gap5">
                    <label for="${extensionName}-summary-tag">摘要标签名（可填多个，用逗号或空格分隔，如：summary, abstract）：</label>
                    <input id="${extensionName}-summary-tag" type="text" class="text_pole" placeholder="summary, abstract" value="${settings.summaryTag}" />
                    <button id="${extensionName}-scan-tags" class="menu_button" style="width: auto; align-self: flex-start;" title="扫描当前聊天记录里有哪些摘要标签">扫描摘要标签</button>
                </div>
                <div class="flex-container flexFlowColumn gap5">
                    <label for="${extensionName}-missing-summary-action">AI 消息缺少 <abstract> 时如何处理：</label>
                    <select id="${extensionName}-missing-summary-action" class="text_pole">
                        <option value="skip" ${settings.missingSummaryAction === 'skip' ? 'selected' : ''}>跳过该轮（安全，默认）</option>
                        <option value="placeholder" ${settings.missingSummaryAction === 'placeholder' ? 'selected' : ''}>插入占位提示（保持轮次结构）</option>
                        <option value="raw" ${settings.missingSummaryAction === 'raw' ? 'selected' : ''}>发送完整原文（会过滤 think/thinking）</option>
                    </select>
                </div>
                <div class="flex-container flexFlowColumn gap5">
                    <label for="${extensionName}-target-length">生成总结的目标长度（token 数，仅作参考，非硬性截断）：</label>
                    <input id="${extensionName}-target-length" type="number" class="text_pole" min="50" value="${settings.targetLength}" />
                </div>
                <div class="flex-container flexFlowColumn gap5">
                    <label for="${extensionName}-max-batch-size">单次最多压缩多少条消息（兜底上限）：</label>
                    <input id="${extensionName}-max-batch-size" type="number" class="text_pole" min="1" value="${settings.maxBatchSize}" />
                </div>
                <div class="flex-container flexFlowColumn gap5">
                    <label for="${extensionName}-injection-label">注入大总结时的开头标签（留空则默认“历史剧情”）：</label>
                    <input id="${extensionName}-injection-label" type="text" class="text_pole" placeholder="历史剧情" value="${settings.injectionLabel}" />
                </div>

                <div class="flex-container flexFlowColumn gap5">
                    <label for="${extensionName}-use-custom-api" class="checkbox_label">
                        <input id="${extensionName}-use-custom-api" type="checkbox" class="checkbox" ${settings.useCustomApi ? 'checked' : ''} />
                        <span>使用自定义 OpenAI 兼容 API 进行总结（不勾选则使用 ST 当前主模型）</span>
                    </label>
                </div>
                <div class="flex-container flexFlowColumn gap5">
                    <label for="${extensionName}-include-char-info" class="checkbox_label">
                        <input id="${extensionName}-include-char-info" type="checkbox" class="checkbox" ${settings.includeCharInfo !== false ? 'checked' : ''} />
                        <span>总结时附带角色卡设定（描述/性格/背景情境，防止人设理解偏差）</span>
                    </label>
                </div>
                <div class="flex-container flexFlowColumn gap5">
                    <label for="${extensionName}-include-world-info" class="checkbox_label">
                        <input id="${extensionName}-include-world-info" type="checkbox" class="checkbox" ${settings.includeWorldInfo !== false ? 'checked' : ''} />
                        <span>总结时附带 World Info（世界书）内容作为背景参考</span>
                    </label>
                </div>
                <div class="flex-container flexFlowColumn gap5">
                    <label for="${extensionName}-custom-base-url">自定义 API Base URL（需以 /v1 结尾）：</label>
                    <input id="${extensionName}-custom-base-url" type="text" class="text_pole" placeholder="https://your-api.com/v1" value="${settings.customBaseUrl}" />
                </div>
                <div class="flex-container flexFlowColumn gap5">
                    <label for="${extensionName}-custom-api-key">自定义 API Key：</label>
                    <input id="${extensionName}-custom-api-key" type="password" class="text_pole" placeholder="sk-..." value="${settings.customApiKey}" />
                </div>
                <div class="flex-container flexFlowColumn gap5">
                    <label for="${extensionName}-custom-model">自定义模型名：</label>
                    <div class="flex-container alignitemscenter gap5">
                        <input id="${extensionName}-custom-model" type="text" class="text_pole flex1" placeholder="模型 ID" value="${settings.customModel}" />
                        <button id="${extensionName}-fetch-custom-models" class="menu_button" style="white-space: nowrap;" title="从自定义 API 拉取模型列表">拉取模型</button>
                    </div>
                </div>

                </div>
                </div>

                <div class="inline-drawer wide100p">
                    <div class="inline-drawer-toggle inline-drawer-header">
                        <b>总结提示词模板</b>
                        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                    </div>
                    <div class="inline-drawer-content">
                        <div class="flex-container flexFlowColumn gap5">
                            <label for="${extensionName}-prompt-template">
                                系统提示词模板：
                                <br /><small>
                                    {{剧情档案}} / {{已有剧情}} = 已有大总结（本轮新增剧情会以对话角色形式单独发送）<br />
                                    {{user}} = User 名称 | {{char}} = 当前角色名称
                                </small>
                            </label>
                            <textarea id="${extensionName}-prompt-template" class="text_pole textarea_compact autoSetHeight" rows="6">${escapeHtml(settings.promptTemplate)}</textarea>
                        </div>
                        <div class="flex-container flexFlowColumn gap5">
                            <label for="${extensionName}-final-user-prompt">最后一条 user 消息（让 AI 开始总结）：</label>
                            <input id="${extensionName}-final-user-prompt" type="text" class="text_pole" value="${escapeHtml(settings.finalUserPrompt)}" />
                        </div>
                    </div>
                </div>

                <div class="flex-container flexFlowColumn gap5">
                    <label>主要操作</label>
                    <div class="flex-container gap5" style="flex-wrap: wrap;">
                        <button id="${extensionName}-manual-btn" class="menu_button" style="flex: 1 1 0; min-width: 70px; white-space: nowrap;" title="立即总结前文">立即总结</button>
                        <button id="${extensionName}-redo-last-btn" class="menu_button" style="flex: 1 1 0; min-width: 70px; white-space: nowrap;" title="撤销最近一次并重做">重新总结</button>
                        <button id="${extensionName}-undo-btn" class="menu_button" style="flex: 1 1 0; min-width: 70px; white-space: nowrap;" title="撤销最近一次总结">撤销</button>
                        <button id="${extensionName}-reset-btn" class="menu_button" style="flex: 1 1 0; min-width: 70px; white-space: nowrap; color: var(--smart-delete-msg-color, #c93636);" title="清空所有总结并恢复隐藏消息">清空</button>
                    </div>
                    <small>“重新总结”= 撤销最近一次并立刻重做；“清空”会删除全部记录并恢复隐藏消息。</small>
                </div>
                <hr />
                <div class="flex-container flexFlowColumn gap5">
                    <label>当前大总结（可手动编辑，保存后立即生效）：</label>
                    <textarea id="${extensionName}-big-summary" class="text_pole textarea_compact autoSetHeight" rows="8"></textarea>
                </div>
                <div class="flex-container flexFlowColumn gap5">
                    <small id="${extensionName}-status">状态：未加载</small>
                </div>
                <div class="flex-container flexFlowColumn gap5">
                    <small id="${extensionName}-debug-log">调试：${escapeHtml(lastDebugMessage)}</small>
                </div>
            </div>
        </div>
    `;

    $('#extensions_settings').append(html);

    $(`#${extensionName}-enabled`).on('input', function () {
        settings.enabled = $(this).prop('checked');
        context.saveSettingsDebounced();
        injectBigSummary(context);
    });

    $(`#${extensionName}-auto-trigger`).on('input', function () {
        settings.autoTrigger = $(this).prop('checked');
        context.saveSettingsDebounced();
    });

    $(`#${extensionName}-injection-label`).on('input', function () {
        settings.injectionLabel = $(this).val().trim() || '历史剧情';
        context.saveSettingsDebounced();
        injectBigSummary(context);
    });

    $(`#${extensionName}-chunk-size`).on('input', function () {
        settings.chunkSize = Number($(this).val()) || 50;
        context.saveSettingsDebounced();
    });

    $(`#${extensionName}-keep-recent`).on('input', function () {
        const v = Number($(this).val());
        settings.keepRecent = isNaN(v) ? 10 : Math.max(0, v);
        context.saveSettingsDebounced();
    });

    $(`#${extensionName}-first-trigger`).on('input', function () {
        settings.firstTrigger = Number($(this).val()) || 60;
        context.saveSettingsDebounced();
    });

    $(`#${extensionName}-summary-tag`).on('input', function () {
        settings.summaryTag = $(this).val().trim() || 'summary';
        context.saveSettingsDebounced();
    });

    $(`#${extensionName}-missing-summary-action`).on('input', function () {
        settings.missingSummaryAction = $(this).val() || 'skip';
        context.saveSettingsDebounced();
    });

    $(`#${extensionName}-scan-tags`).on('click', function () {
        const result = scanSummaryTags(context);
        if (!result) {
            toastr.warning('当前没有聊天记录可扫描');
            return;
        }
        if (result.hits.length === 0) {
            toastr.error(`扫描完成：在 ${result.totalAiMessages} 条 AI 消息中未找到任何摘要标签`);
            return;
        }
        const lines = result.hits.map(([tag, count]) => {
            const first = result.firstHits[tag];
            return `&lt;${tag}&gt;：${count} 条（首次出现在 #${first}）`;
        }).join('\n');
        const topTag = result.hits[0][0];
        toastr.success(`检测到以下摘要标签（共扫描 ${result.totalAiMessages} 条 AI 消息）：\n${lines}`, '', { timeOut: 8000 });
        logDebug(`扫描标签：${result.hits.map(([t, c]) => `${t}=${c}`).join(', ')}`);
        if (settings.summaryTag !== topTag && confirm(`是否将 summary 标签名自动改为 "${topTag}"？`)) {
            settings.summaryTag = topTag;
            context.saveSettingsDebounced();
            $(`#${extensionName}-summary-tag`).val(topTag);
        }
    });

    $(`#${extensionName}-target-length`).on('input', function () {
        settings.targetLength = Number($(this).val()) || 20000;
        context.saveSettingsDebounced();
    });

    $(`#${extensionName}-max-batch-size`).on('input', function () {
        settings.maxBatchSize = Number($(this).val()) || 200;
        context.saveSettingsDebounced();
    });

    $(`#${extensionName}-use-custom-api`).on('input', function () {
        settings.useCustomApi = $(this).prop('checked');
        context.saveSettingsDebounced();
    });

    $(`#${extensionName}-include-char-info`).on('input', function () {
        settings.includeCharInfo = $(this).prop('checked');
        context.saveSettingsDebounced();
    });

    $(`#${extensionName}-include-world-info`).on('input', function () {
        settings.includeWorldInfo = $(this).prop('checked');
        context.saveSettingsDebounced();
    });

    $(`#${extensionName}-custom-base-url`).on('input', function () {
        settings.customBaseUrl = $(this).val();
        context.saveSettingsDebounced();
    });

    $(`#${extensionName}-custom-api-key`).on('input', function () {
        settings.customApiKey = $(this).val();
        context.saveSettingsDebounced();
    });

    $(`#${extensionName}-custom-model`).on('input', function () {
        settings.customModel = $(this).val();
        context.saveSettingsDebounced();
    });

    $(`#${extensionName}-fetch-custom-models`).on('click', async function () {
        try {
            const models = await fetchCustomModels(context);
            const current = settings.customModel;
            let options = models.map(m => `<option value="${m}" ${m === current ? 'selected' : ''}>${m}</option>`).join('');
            if (!models.includes(current) && current) {
                options = `<option value="${current}" selected>${current}</option>` + options;
            }
            $(`#${extensionName}-custom-model`).replaceWith(`
                <select id="${extensionName}-custom-model" class="text_pole flex1">${options}</select>
            `);
            $(`#${extensionName}-custom-model`).on('input', function () {
                settings.customModel = $(this).val();
                context.saveSettingsDebounced();
            });
            toastr.success(`拉取到 ${models.length} 个模型`);
            logDebug(`自定义 API 模型列表：${models.length} 个`);
        } catch (err) {
            logDebug(`拉取模型失败：${err.message || err}`);
            toastr.error(`拉取模型失败：${err.message || err}`);
        }
    });

    $(`#${extensionName}-prompt-template`).on('input', function () {
        settings.promptTemplate = $(this).val();
        context.saveSettingsDebounced();
    });

    $(`#${extensionName}-final-user-prompt`).on('input', function () {
        settings.finalUserPrompt = $(this).val();
        context.saveSettingsDebounced();
    });

    $(`#${extensionName}-manual-btn`).on('click', function () {
        const messageCount = context.chat?.length ?? 0;
        logDebug(`手动按钮点击，当前总消息 ${messageCount}`);
        if (messageCount > 0) {
            runSummarization(context, messageCount);
        } else {
            toastr.warning('当前没有聊天记录');
        }
    });

    $(`#${extensionName}-reset-btn`).on('click', function () {
        if (!confirm('确定要清空所有总结吗？\n这会删除大总结、历史版本，并恢复所有被隐藏的消息。')) return;
        clearAllSummaries(context);
    });

    $(`#${extensionName}-undo-btn`).on('click', function () {
        undoLastSummarization(context);
    });

    $(`#${extensionName}-redo-last-btn`).on('click', async function () {
        await undoLastSummarization(context);
        const messageCount = context.chat?.length ?? 0;
        if (messageCount > 0) {
            await runSummarization(context, messageCount);
        }
    });

    $(`#${extensionName}-big-summary`).on('input', function () {
        const meta = getMeta(context);
        if (!meta) return;
        meta.bigSummary = $(this).val();
        context.updateChatMetadata({ [extensionName]: meta });
        context.saveMetadataDebounced();
        injectBigSummary(context);
    });
}

function updateUi(context) {
    const settings = getSettings(context);
    const meta = getMeta(context);
    const messageCount = context.chat?.length ?? 0;
    if (!settings || !meta) return;

    $(`#${extensionName}-enabled`).prop('checked', settings.enabled);
    $(`#${extensionName}-auto-trigger`).prop('checked', settings.autoTrigger);
    $(`#${extensionName}-injection-label`).val(settings.injectionLabel);
    $(`#${extensionName}-chunk-size`).val(settings.chunkSize);
    $(`#${extensionName}-keep-recent`).val(settings.keepRecent);
    $(`#${extensionName}-first-trigger`).val(settings.firstTrigger);
    $(`#${extensionName}-summary-tag`).val(settings.summaryTag);
    $(`#${extensionName}-missing-summary-action`).val(settings.missingSummaryAction || 'skip');
    $(`#${extensionName}-target-length`).val(settings.targetLength);
    $(`#${extensionName}-max-batch-size`).val(settings.maxBatchSize);
    $(`#${extensionName}-use-custom-api`).prop('checked', settings.useCustomApi);
    $(`#${extensionName}-include-char-info`).prop('checked', settings.includeCharInfo !== false);
    $(`#${extensionName}-include-world-info`).prop('checked', settings.includeWorldInfo !== false);
    $(`#${extensionName}-custom-base-url`).val(settings.customBaseUrl);
    $(`#${extensionName}-custom-api-key`).val(settings.customApiKey);
    $(`#${extensionName}-custom-model`).val(settings.customModel);
    $(`#${extensionName}-prompt-template`).val(settings.promptTemplate);
    $(`#${extensionName}-final-user-prompt`).val(settings.finalUserPrompt);
    $(`#${extensionName}-big-summary`).val(meta.bigSummary);
    logDebug(`UI 更新：bigSummary 长度 ${meta.bigSummary.length}，${meta.lastSummarizedMessageIndex < 0 ? '当前未总结任何消息' : `已总结到 #${meta.lastSummarizedMessageIndex}`}`);

    let status;
    const summaryLen = (meta.bigSummary || '').length;
    if (meta.isSummarizing) {
        status = '正在总结中...';
    } else {
        status = meta.lastSummarizedMessageIndex < 0
            ? `当前未总结 | 总消息：${messageCount}`
            : `已总结到 #0~#${meta.lastSummarizedMessageIndex} | 总消息：${messageCount}`;
        status += ` | 大总结：${summaryLen} 字符`;
        if (settings.autoTrigger) {
            status += ` | 下次触发：#${meta.nextTriggerFloor}`;
        }
    }
    $(`#${extensionName}-status`).text(status);
    $(`#${extensionName}-debug-log`).text(lastDebugMessage);
}

export function init() {
    const context = SillyTavern.getContext();
    logDebug('扩展已初始化');

    if (context.eventSource && context.eventTypes) {
        context.eventSource.on(context.eventTypes.CHARACTER_MESSAGE_RENDERED, () => {
            checkAndRunTriggers(context);
        });

        context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => {
            onChatChanged(context);
            checkAndRunTriggers(context);
        });

        context.eventSource.on(context.eventTypes.GENERATION_AFTER_COMMANDS, () => {
            onGenerationAfterCommands(context);
        });
    }

    if (context.eventSource && context.eventTypes && context.eventTypes.APP_READY) {
        context.eventSource.on(context.eventTypes.APP_READY, () => {
            addSettingsPanel(context);
            onChatChanged(context);
        });
    } else {
        addSettingsPanel(context);
        onChatChanged(context);
    }
}
