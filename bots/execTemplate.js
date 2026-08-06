// __log is bound as a default parameter, not in the body, so it resolves in the
// parameter scope -- outside the block the generated code is spliced into. The
// model writes `const log = bot.findBlock(...)` constantly in a forest, and that
// shadowed the logger for the whole body, so this epilogue died on "log is not
// a function" after the code it was reporting on had already succeeded.
(async (bot, __log = log) => {

/* CODE HERE */
__log(bot, 'Code finished.');

})
