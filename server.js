const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fs = require('fs');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const port = process.env.PORT || 3001;
app.use(cors());
app.use(bodyParser.json());

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

// Load German questions
let germanQuestions;
try {
    const raw = fs.readFileSync('german_questions.json', 'utf-8');
    germanQuestions = JSON.parse(raw);
    console.log(`Loaded ${germanQuestions.length} questions`);
} catch (e) {
    console.error('Failed to load german_questions.json', e);
    germanQuestions = [];
}

// MongoDB (optional)
const mongoClient = new MongoClient(process.env.MONGO_URI);
let db;
(async () => {
    try {
        await mongoClient.connect();
        db = mongoClient.db('german_bot');
        console.log('Connected to MongoDB');
    } catch (e) {
        console.error('MongoDB connect error', e);
        process.exit(1);
    }
})();

const storeChatHistory = async (user, ai) => {
    try {
        await db.collection('chat_history').insertOne({ user, ai, timestamp: new Date() });
    } catch (e) {
        console.error('History store error', e);
    }
};

const userSessions = {};
const QUESTIONS_PER_ROUND = 5;

// normalize: trim, remove punctuation, lowercase
const normalize = s => s.trim().replace(/[?.!]/g, '').toLowerCase();

// Generate next-level questions via Gemini
async function generateNextLevelQuestions(prevAnswers, prevQuestions, nextLevel) {
    const context = prevAnswers.map((ans,i) => {
        const q = prevQuestions[i];
        return `Q: ${q.question} | Your answer: ${ans.userAnswer} | Correct: ${ans.correct}`;
    }).join('\n');
    const prompt = `
You are a German language quiz generator.
Based on the user's previous answers and performance:
${context}
Now generate 5 new, slightly harder (level ${nextLevel}) German vocabulary multiple-choice questions.
Each should be: { "question": "...", "options": [...], "answer": "...", "level": "${nextLevel}" }
Return a JSON array, no explanation, no markdown.
    `;
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
    const res = await model.generateContent(prompt);
    const txt = res.response.text();
    try { return JSON.parse(txt); }
    catch(e) { console.error('Parse error', e, txt); return []; }
}

app.post('/api/ask', async (req, res) => {
    try {
        const { userId, answer } = req.body;
        if (!userId) throw new Error('userId is required');

        // init session
        if (!userSessions[userId]) {
            userSessions[userId] = {
                questions: germanQuestions.slice(0, QUESTIONS_PER_ROUND),
                questionPointer: 0,
                answers: [],
                prevQuestions: [],
                prevAnswers: [],
                round: 1,
                level: 'A1'
            };
        }
        const session = userSessions[userId];

        // detect commands in answer
        const ansNorm = answer ? normalize(answer) : '';
        const doContinue = ['continue','next','yes'].includes(ansNorm);
        const endSession = ['end','stop','no','quit'].includes(ansNorm);

        // end session
        if (endSession) {
            delete userSessions[userId];
            return res.json({ success: true, response: 'Session ended. Auf Wiedersehen!', done: true });
        }

        // continue to next level
        if (doContinue && session.answers.length >= QUESTIONS_PER_ROUND) {
            const nextLevel = session.level === 'A1' ? 'A2'
                : session.level === 'A2' ? 'B1'
                : session.level === 'B1' ? 'B2'
                : session.level === 'B2' ? 'C1'
                : session.level;
            const newQs = await generateNextLevelQuestions(
                session.prevAnswers, session.prevQuestions, nextLevel
            );
            if (!newQs.length) {
                return res.json({ success: false, response: 'Could not generate questions.', done: true });
            }
            session.level = nextLevel;
            session.questions = newQs;
            session.questionPointer = 0;
            session.answers = [];
            session.prevQuestions = [];
            session.prevAnswers = [];
            session.round += 1;
            const q = session.questions[0];
            session.questionPointer = 1;
            return res.json({
                success: true,
                response: `${q.question}\nA) ${q.options[0]}\nB) ${q.options[1]}\nC) ${q.options[2]}\nD) ${q.options[3]}`,
                message: `Level up! Now at ${nextLevel}.`
            });
        }

        // process normal answer
        let feedback = '';
        if (answer && session.questionPointer > 0) {
            const q = session.questions[session.questionPointer - 1];
            // get feedback from Gemini
            const prompt = `
You are a friendly German tutor...
Question: "${q.question}"
Options: A) ${q.options[0]}, B) ${q.options[1]}, C) ${q.options[2]}, D) ${q.options[3]}
Correct answer: "${q.answer}"
Student's answer: "${answer}"
Respond in English and German.
            `;
            try {
                const mdl = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
                const out = await mdl.generateContent(prompt);
                feedback = out.response.text();
            } catch {
                feedback = `Correct answer: ${q.answer}`;
            }
            // check correctness
            const corr = normalize(q.answer);
            const opts = q.options.map(o => normalize(o));
            const isCorrect = ansNorm === corr
                || (['a','b','c','d'].includes(ansNorm)
                    && opts['abcd'.indexOf(ansNorm)] === corr);
            session.answers.push(isCorrect);
            session.prevQuestions.push(q);
            session.prevAnswers.push({ userAnswer: answer, correct: isCorrect });
            await storeChatHistory(answer, feedback);
        }

        // round summary
        if (session.answers.length > 0
            && session.answers.length % QUESTIONS_PER_ROUND === 0) {
            const lastFb = feedback ? `Feedback:\n${feedback}\n\n` : '';
            const roundQs = session.prevQuestions.slice(-QUESTIONS_PER_ROUND);
            const roundAns = session.answers.slice(-QUESTIONS_PER_ROUND);
            const roundUsr = session.prevAnswers.slice(-QUESTIONS_PER_ROUND);
            const correctCount = roundAns.filter(x => x).length;
            const mistakes = [];
            roundAns.forEach((ok, i) => {
                if (!ok) {
                    mistakes.push(
                        `Q${i+1}: ${roundQs[i].question}\n` +
                        `Your answer: ${roundUsr[i].userAnswer}\n` +
                        `Correct answer: ${roundQs[i].answer}`
                    );
                }
            });
            let msg = `${lastFb}Round ${session.round} finished: ${correctCount}/${QUESTIONS_PER_ROUND} correct.`;
            if (mistakes.length) {
                msg += `\n\nQuestions missed:\n${mistakes.join('\n\n')}`;
            }
            msg += `\n\nType 'continue' to level up, or 'end' to finish.`;
            return res.json({
                success: true,
                response: msg,
                continueAvailable: true
            });
        }

        // next question
        if (session.questionPointer >= session.questions.length) {
            return res.json({
                success: true,
                response: 'No more questions in this round.',
                message: 'Done!'
            });
        }
        const q = session.questions[session.questionPointer];
        session.questionPointer++;
        return res.json({
            success: true,
            response: `${q.question}\nA) ${q.options[0]}\nB) ${q.options[1]}\nC) ${q.options[2]}\nD) ${q.options[3]}`,
            feedback,
            message: 'Next question.'
        });
    } catch (err) {
        console.error('Bot error', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/end', (req, res) => {
    const { userId } = req.body;
    delete userSessions[userId];
    res.json({ success: true, message: 'Session ended.' });
});

app.get('/health', (_, res) => res.json({ status: 'healthy' }));

const server = app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});

process.on('SIGTERM', async () => {
    console.log('Shutting down...');
    await mongoClient.close();
    server.close(() => process.exit(0));
});