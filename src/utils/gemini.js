// Fix for corporate SSL proxy / firewall
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { BrowserWindow, ipcMain } = require('electron');
const { getSystemPrompt } = require('./prompts');

let currentSessionId = null;
let conversationHistory = [];
let activeProfile = 'interview';
let activeCustomPrompt = '';
let latestScreenBase64 = null;

// Audio buffer for voice recognition
let audioChunks = [];
let audioByteCount = 0;
let isTranscribing = false;
let lastProcessedTime = Date.now();

// =========================================================================
// 🔑 API KEYS (Put your keys here)
// =========================================================================


// =========================================================================

function sendToRenderer(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
        windows[0].webContents.send(channel, data);
    }
}

function initializeNewSession() {
    currentSessionId = Date.now().toString();
    conversationHistory = [];
    audioChunks = [];
    audioByteCount = 0;
    console.log('🎯 Universal Interview Assistant Connected:', currentSessionId);
}

function saveConversationTurn(transcription, aiResponse) {
    if (!currentSessionId) initializeNewSession();

    const turn = {
        timestamp: Date.now(),
        transcription: transcription.trim(),
        ai_response: aiResponse.trim(),
    };
    conversationHistory.push(turn);
    sendToRenderer('save-conversation-turn', {
        sessionId: currentSessionId,
        turn,
        fullHistory: conversationHistory,
    });
}

function pcmToWav(pcmBuffer, sampleRate = 24000) {
    const numChannels = 1;
    const bitDepth = 16;
    const byteRate = sampleRate * numChannels * (bitDepth / 8);
    const blockAlign = numChannels * (bitDepth / 8);
    const header = Buffer.alloc(44);

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcmBuffer.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitDepth, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcmBuffer.length, 40);

    return Buffer.concat([header, pcmBuffer]);
}

// Check if speech is a real question
function isRealQuestion(text) {
    if (!text || text.length < 8) return false;

    const lower = text.toLowerCase().trim();
    const ignored = ['okay.', 'okay', 'hello.', 'hello', 'please', 'thank you.', 'thank you', 'thanks.', 'you you', 'subtitles by', 'still watch'];
    if (ignored.includes(lower)) return false;

    const questionKeywords = ['what', 'how', 'why', 'explain', 'describe', 'difference', 'can you', 'tell me', 'stages', 'architecture', 'pipeline', 'process', 'steps', 'experience', 'yourself', 'code', 'design'];
    const hasKeyword = questionKeywords.some(kw => lower.includes(kw));

    return hasKeyword || text.length > 20;
}

// Transcribe audio using Groq Whisper
async function transcribeAudioBuffer() {
    if (isTranscribing || audioChunks.length === 0 || !GROQ_API_KEY) return;

    isTranscribing = true;
    const pcmBuffer = Buffer.concat(audioChunks);
    audioChunks = [];
    audioByteCount = 0;

    if (pcmBuffer.length < 24000 * 3) {
        isTranscribing = false;
        return;
    }

    try {
        const wavBuffer = pcmToWav(pcmBuffer, 24000);
        const file = new File([wavBuffer], 'audio.wav', { type: 'audio/wav' });
        const formData = new FormData();
        formData.append('file', file);
        formData.append('model', 'whisper-large-v3');
        formData.append('language', 'en');
        formData.append('prompt', 'Technical software engineering, architecture, coding, system design, interview questions.');

        const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GROQ_API_KEY.trim()}`,
            },
            body: formData,
        });

        const resText = await response.text();

        if (response.ok) {
            const data = JSON.parse(resText);
            const transcript = data.text ? data.text.trim() : '';

            if (transcript) {
                console.log('\n🎤 Heard:', transcript);

                if (isRealQuestion(transcript)) {
                    console.log('🎯 Valid Interview Question Triggered:', transcript);
                    sendToRenderer('update-status', `Thinking: "${transcript.slice(0, 35)}..."`);

                    // 1-second natural pause
                    await new Promise(resolve => setTimeout(resolve, 1000));

                    await streamOpenAIResponse(transcript, latestScreenBase64);
                } else {
                    console.log('⏩ Filtered out filler words. Waiting for full question...');
                }
            }
        }
    } catch (err) {
        console.error('\n❌ Transcription Error:', err);
    } finally {
        isTranscribing = false;
    }
}

function handleIncomingAudio(data) {
    if (!data) return;
    try {
        const buffer = Buffer.from(data, 'base64');
        audioChunks.push(buffer);
        audioByteCount += buffer.length;

        process.stdout.write('~');

        const now = Date.now();
        // 4.5 seconds speaking window
        if (now - lastProcessedTime >= 4500 && audioByteCount > 24000 * 3) {
            lastProcessedTime = now;
            transcribeAudioBuffer();
        }
    } catch (e) {
        console.error('Error handling audio:', e);
    }
}

async function initializeGeminiSession(apiKey, customPrompt = '', profile = 'interview', language = 'en-US') {
    activeProfile = profile;
    activeCustomPrompt = customPrompt;
    initializeNewSession();

    sendToRenderer('session-initializing', false);
    sendToRenderer('update-status', 'Live session connected');

    console.log('🎤 Assistant Ready: Listening to Interviewer via Groq + OpenAI!');
    return { active: true };
}

// Stream answer from OpenAI GPT-4o-mini
async function streamOpenAIResponse(promptText, imageBase64 = null) {
    sendToRenderer('update-status', `Answering: "${promptText.slice(0, 30)}..."`);

    // Dynamic prompt: Uses whatever context or resume is entered in the UI Settings
    const candidateContext = activeCustomPrompt || 'Senior Software / Technical Professional.';

    const systemInstruction = `
You are the secret live interview co-pilot for the candidate.

CANDIDATE RESUME & CONTEXT:
${candidateContext}

STRICT OUTPUT RULES:
1. FIRST PERSON: Speak as the candidate ("In my experience...", "In my previous project, we implemented...").
2. CRISP BULLET POINTS: Give MAX 3 to 4 punchy, high-impact bullet points. Total words under 70 words.
3. BOLD KEYWORDS: Put key tools, frameworks, and architecture patterns in **BOLD** so the candidate can read them at a glance.
4. CODING: If asked for code, output ONLY 4 to 8 lines of direct working code with zero fluff.
5. SELF-INTRO: If asked "Tell me about yourself", deliver a crisp 40-second pitch based on the candidate's provided context.
`;

    const userContent = [];
    if (imageBase64) {
        userContent.push({
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${imageBase64}` }
        });
    }
    userContent.push({
        type: 'text',
        text: promptText
    });

    const messages = [
        { role: 'system', content: systemInstruction },
        ...conversationHistory.slice(-4).map(turn => [
            { role: 'user', content: turn.transcription },
            { role: 'assistant', content: turn.ai_response }
        ]).flat(),
        { role: 'user', content: userContent }
    ];

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY.trim()}`,
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: messages,
                stream: true,
                max_tokens: 400,
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`OpenAI HTTP ${response.status}: ${errText}`);
        }

        let fullAnswer = '';
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            const lines = chunk.split('\n');

            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
                    try {
                        const parsed = JSON.parse(trimmed.slice(6));
                        const content = parsed.choices?.[0]?.delta?.content;
                        if (content) {
                            fullAnswer += content;
                            sendToRenderer('update-response', fullAnswer);
                        }
                    } catch (e) {}
                }
            }
        }

        saveConversationTurn(promptText, fullAnswer);
        sendToRenderer('update-status', 'Listening (Ready)');
        return fullAnswer;
    } catch (err) {
        console.error('OpenAI Error:', err.message);
        sendToRenderer('update-status', 'Error: ' + err.message);
    }
}

function setupGeminiIpcHandlers(geminiSessionRef) {
    global.geminiSessionRef = geminiSessionRef;

    ipcMain.handle('initialize-gemini', async (event, apiKey, customPrompt, profile = 'interview', language = 'en-US') => {
        const session = await initializeGeminiSession(apiKey, customPrompt, profile, language);
        if (session) {
            geminiSessionRef.current = session;
            return true;
        }
        return false;
    });

    // 1. Meeting Audio (Interviewer Voice) -> Auto Answer
    ipcMain.handle('send-audio-content', async (event, { data }) => {
        handleIncomingAudio(data);
        return { success: true };
    });

    // 2. Candidate Mic -> Ignored so their own voice does not trigger answers
    ipcMain.handle('send-mic-audio-content', async (event, { data }) => {
        return { success: true };
    });

    // Screen Share capture
    ipcMain.handle('send-image-content', async (event, { data }) => {
        if (data) latestScreenBase64 = data;
        return { success: true };
    });

    // Manual chat box fallback
    ipcMain.handle('send-text-message', async (event, text) => {
        if (!text) return { success: false };
        streamOpenAIResponse(text, latestScreenBase64);
        return { success: true };
    });

    ipcMain.handle('start-macos-audio', async () => ({ success: false }));
    ipcMain.handle('stop-macos-audio', async () => ({ success: true }));

    ipcMain.handle('close-session', async () => {
        latestScreenBase64 = null;
        audioChunks = [];
        sendToRenderer('update-status', 'Session closed');
        return { success: true };
    });

    ipcMain.handle('get-current-session', async () => ({
        success: true,
        data: { sessionId: currentSessionId, history: conversationHistory }
    }));

    ipcMain.handle('start-new-session', async () => {
        initializeNewSession();
        return { success: true, sessionId: currentSessionId };
    });

    ipcMain.handle('update-google-search-setting', async () => ({ success: true }));
}

function stopMacOSAudioCapture() {}

module.exports = {
    initializeGeminiSession,
    setupGeminiIpcHandlers,
    stopMacOSAudioCapture,
};
