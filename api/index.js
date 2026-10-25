// Vercel function: every request is routed here (see vercel.json) and handled by the compiled Nest app.
// `npm run vercel-build` compiles src/ into dist/ before Vercel bundles this file.
module.exports = require("../dist/serverless").default;
