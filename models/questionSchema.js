const mongoose = require("mongoose");

const questionSchema = new mongoose.Schema({
    problem: String,
    hint_1: String,
    hint_2: String,
    solution_explained: String,
    code_python: String,
    code_cpp: String
});

module.exports = mongoose.model("Question", questionSchema);
