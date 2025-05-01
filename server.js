const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const port = process.env.PORT || 3001;
app.use(cors());
app.use(bodyParser.json());

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

// OPTIONAL: MongoDB
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
    if (!db) return;
    await db.collection('chat_history').insertOne({ user, ai, timestamp: new Date() });
  } catch (e) {
    console.error('History store error', e);
  }
};

const userSessions = {};
const QUESTIONS_PER_ROUND = 5;

// Normalize user answers
const normalize = str => str.trim().replace(/[?.!]/g, '').toLowerCase();

// Generate next-level questions using Gemini LLM
async function generateNextLevelQuestions(prevAnswers, prevQuestions, nextLevel) {
  const context = prevAnswers.map((ans, i) => {
    const q = prevQuestions[i];
    return `Q: ${q.question} | Your answer: ${ans.userAnswer} | Correct: ${ans.correct}`;
  }).join('\n');

  const prompt = `
You are a German language quiz generator.
Based on the user's previous answers and performance:
${context}
Now generate 5 new, slightly harder (level ${nextLevel}) German vocabulary multiple-choice questions.
All questions and answer options must be in English, not German. Do not use German in the question or options.
just ask german word meaning or opposite of this in german like this 
The correct answer should be randomly placed among the options, not always in position A.
Each should be a JSON object:
{
  "question": "What is the meaning of 'Apfel'?",
  "options": ["Apple", "Dog", "House", "Cat"],
  "answer": "Apple",
  "level": "${nextLevel}"
}
Return a JSON array, no explanation, no markdown.
  `;

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
    const result = await model.generateContent(prompt);
    let text = result.response.text();
    // Remove code fences if present
    text = text.replace(/```json|```/gi, '').trim();
    const arr = JSON.parse(text);
    return arr;
  } catch (err) {
    console.error('Gemini question generation error:', err);
    return "gemini fails ";
  }
}

app.post('/api/ask', async (req, res) => {
  try {
    const { userId, answer } = req.body;
    if (!userId) throw new Error('userId is required.');

    // If new user, generate 5 brand new questions at A1 plus a welcome message
    if (!userSessions[userId]) {
      const initQs = await generateNextLevelQuestions([], [], 'A1');
      if (initQs === "gemini fails ") {
        return res.json({ 
          success: false, 
          response: "Gemini fail: unable to generate initial questions." 
        });
      }
      userSessions[userId] = {
        questions: initQs,
        questionPointer: 0,
        answers: [],
        prevQuestions: [],
        prevAnswers: [],
        round: 1,
        level: 'A1',
        welcomeShown: false
      };
    }

    const session = userSessions[userId];

    // Always show welcome message if not shown yet
    if (!session.welcomeShown) {
      session.welcomeShown = true;
      // If user already sent an answer, show feedback for it after welcome
      if (answer) {
        const firstQ = session.questions[0];
        let feedback = '';
        const prompt = `
You are a friendly German tutor. The student is learning German and may answer in English or incorrect German.
- If correct, praise them.
- If incorrect, correct them.
- Use a helpful, encouraging tone in English and German.
Question: "${firstQ.question}"
Options: A) ${firstQ.options[0]}, B) ${firstQ.options[1]}, C) ${firstQ.options[2]}, D) ${firstQ.options[3]}
Correct answer: "${firstQ.answer}"
Student's answer: "${answer}"
        `;
        try {
          const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
          const result = await model.generateContent(prompt);
          feedback = result.response.text();
        } catch (err) {
          feedback = `Correct answer: ${firstQ.answer}`;
        }
        const correctNormalized = normalize(firstQ.answer);
        const userNormalized = normalize(answer);
        const optionsNorm = firstQ.options.map(o => normalize(o));
        const isCorrect = 
          userNormalized === correctNormalized ||
          (['a','b','c','d'].includes(userNormalized) &&
           optionsNorm['abcd'.indexOf(userNormalized)] === correctNormalized);

        session.answers.push(isCorrect);
        session.prevQuestions.push(firstQ);
        session.prevAnswers.push({ userAnswer: answer, correct: isCorrect });
        session.questionPointer = 1;

        return res.json({
          success: true,
          response: `Willkommen! Ready to practice German? Let's start!\n\n${feedback}\n\n${firstQ.question}\nA) ${firstQ.options[0]}\nB) ${firstQ.options[1]}\nC) ${firstQ.options[2]}\nD) ${firstQ.options[3]}`,
          message: "Welcome"
        });
      } else {
        const firstQ = session.questions[0];
        session.questionPointer = 1;
        return res.json({
          success: true,
          response: `Willkommen! Ready to practice German? Let's start!\n\n${firstQ.question}\nA) ${firstQ.options[0]}\nB) ${firstQ.options[1]}\nC) ${firstQ.options[2]}\nD) ${firstQ.options[3]}`,
          message: "Welcome"
        });
      }
    }

    // Check for user commands in answer
    const ansNorm = answer ? normalize(answer) : '';
    const doContinue = ['continue','next','yes'].includes(ansNorm);
    const endSession = ['end','stop','no','quit'].includes(ansNorm);

    // End session command
    if (endSession) {
      delete userSessions[userId];
      return res.json({ success: true, response: 'Session ended. Auf Wiedersehen!', done: true });
    }

    // Continue (level up) only if we've answered a round
    if (doContinue && session.answers.length % QUESTIONS_PER_ROUND === 0 && session.answers.length > 0) {
      let nextLevel = session.level === 'A1' ? 'A2'
        : session.level === 'A2' ? 'B1'
        : session.level === 'B1' ? 'B2'
        : session.level === 'B2' ? 'C1'
        : 'C1';

      const newQs = await generateNextLevelQuestions(session.prevAnswers, session.prevQuestions, nextLevel);
      if (newQs === "gemini fails ") {
        return res.json({ 
          success: false, 
          response: "Gemini fail: couldn't generate new questions.", 
          done: true 
        });
      }
      session.level = nextLevel;
      session.questions = newQs;
      session.questionPointer = 0;
      session.answers = [];
      session.prevQuestions = [];
      session.prevAnswers = [];
      session.round += 1;

      const firstQ = session.questions[0];
      session.questionPointer = 1;
      return res.json({
        success: true,
        response: `Level up! Now at ${nextLevel}.\n\n${firstQ.question}\nA) ${firstQ.options[0]}\nB) ${firstQ.options[1]}\nC) ${firstQ.options[2]}\nD) ${firstQ.options[3]}`,
        message: `Now at level ${nextLevel}.`
      });
    }

    let feedback = '';

    // If user provided an answer (and not the first question)
    if (answer && session.questionPointer > 0) {
      const currentQuestion = session.questions[session.questionPointer - 1];
      const prompt = `
You are a friendly German tutor. The student is learning German and may answer in English or incorrect German.
- If correct, praise them.
- If incorrect, correct them.
- Use a helpful, encouraging tone in English and German.
Question: "${currentQuestion.question}"
Options: A) ${currentQuestion.options[0]}, B) ${currentQuestion.options[1]}, C) ${currentQuestion.options[2]}, D) ${currentQuestion.options[3]}
Correct answer: "${currentQuestion.answer}"
Student's answer: "${answer}"
      `;
      try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
        const result = await model.generateContent(prompt);
        feedback = result.response.text();
      } catch (err) {
        feedback = `Correct answer: ${currentQuestion.answer}`;
      }

      const correctNormalized = normalize(currentQuestion.answer);
      const userNormalized = ansNorm;
      const optionsNorm = currentQuestion.options.map(o => normalize(o));
      const isCorrect = 
        userNormalized === correctNormalized ||
        (['a','b','c','d'].includes(userNormalized) &&
         optionsNorm['abcd'.indexOf(userNormalized)] === correctNormalized);

      session.answers.push(isCorrect);
      session.prevQuestions.push(currentQuestion);
      session.prevAnswers.push({ userAnswer: answer, correct: isCorrect });

      await storeChatHistory(answer, feedback);
    }

    // If we completed a round => show summary
    if (session.answers.length > 0 && session.answers.length % QUESTIONS_PER_ROUND === 0) {
      const lastFb = feedback ? `Feedback:\n${feedback}\n\n` : '';
      const roundQs = session.prevQuestions.slice(-QUESTIONS_PER_ROUND);
      const roundAns = session.answers.slice(-QUESTIONS_PER_ROUND);
      const roundUsr = session.prevAnswers.slice(-QUESTIONS_PER_ROUND);

      const correctCount = roundAns.filter(ok => ok).length;
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

    // If no more questions in this round
    if (session.questionPointer >= session.questions.length) {
      return res.json({
        success: true,
        response: 'No more questions in this round.',
        message: 'Done!'
      });
    }

    // Provide next question
    // Provide next question
const nextQ = session.questions[session.questionPointer];
session.questionPointer++;
res.json({
  success: true,
  response: (feedback ? `Feedback: ${feedback}\n\n` : '') +
            `${nextQ.question}\nA) ${nextQ.options[0]}\nB) ${nextQ.options[1]}\nC) ${nextQ.options[2]}\nD) ${nextQ.options[3]}`,
  message: 'Next question.'
});
   
  } catch (error) {
    console.error('Error in /api/ask:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/end', (req, res) => {
  const { userId } = req.body;
  if (userId) delete userSessions[userId];
  res.json({ success: true, message: 'Session ended.' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

const server = app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  await mongoClient.close();
  server.close(() => process.exit(0));
});