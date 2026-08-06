import { writeFile, readFile, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { makeCompartment, lockdown } from './library/lockdown.js';
import * as skills from './library/skills.js';
import * as world from './library/world.js';
import { Vec3 } from 'vec3';
import pf from 'mineflayer-pathfinder';
import {ESLint} from "eslint";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Real skill names closest to one the model made up.
 *
 * Matches on the bare function name rather than the whole `skills.x` path,
 * since half the mistakes are the right function behind the wrong object
 * (world.getCraftingPlan, skills.craft). Ranked by shared prefix and then by
 * one name containing the other, which covers goTo->goToPosition and
 * getBlockAt->getBlockAtPosition without dragging in an edit-distance library.
 */
export function nearestSkills(missing, knownSkills, limit = 3) {
    const bare = (name) => name.split('.').pop().toLowerCase();
    // camelCase to words, minus the filler verbs that relate nothing.
    const FILLER = new Set(['get', 'to', 'at', 'the', 'a', 'for', 'is', 'my']);
    const words = (name) => name.split('.').pop()
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/)
        .filter(w => w.length >= 3 && !FILLER.has(w));
    const target = bare(missing);
    const scored = [];
    for (const known of knownSkills) {
        const candidate = bare(known);
        let score = 0;
        if (candidate === target) score = 1000;
        else if (candidate.startsWith(target) || target.startsWith(candidate)) score = 500 + Math.min(candidate.length, target.length);
        else if (candidate.includes(target) || target.includes(candidate)) score = 250;
        else {
            let shared = 0;
            while (shared < candidate.length && shared < target.length && candidate[shared] === target[shared]) shared++;
            if (shared >= 4) score = shared;
            // Otherwise compare camelCase words, which is the only thing
            // relating getCraftingPlan to craftRecipe: "crafting" and "craft"
            // are the same idea and share no useful prefix with "get".
            else {
                const overlap = words(missing).filter(w => words(known).some(k => k.startsWith(w) || w.startsWith(k))).length;
                if (overlap) score = 100 + overlap;
            }
        }
        if (score) scored.push({ known, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.known);
}

export class Coder {
    constructor(agent) {
        this.agent = agent;
        this.file_counter = 0;
        this.fp = '/bots/'+agent.name+'/action-code/';
        this.code_template = '';
        this.code_lint_template = '';

        readFile(path.join(__dirname, '../../bots/execTemplate.js'), 'utf8', (err, data) => {
            if (err) throw err;
            this.code_template = data;
        });
        readFile(path.join(__dirname, '../../bots/lintTemplate.js'), 'utf8', (err, data) => {
            if (err) throw err;
            this.code_lint_template = data;
        });
        mkdirSync('.' + this.fp, { recursive: true });
    }

    async generateCode(agent_history) {
        this.agent.bot.modes.pause('unstuck');
        lockdown();
        // this message history is transient and only maintained in this function
        let messages = agent_history.getHistory(); 
        messages.push({role: 'system', content: 'Code generation started. Write code in codeblock in your response:'});

        const MAX_ATTEMPTS = 5;
        const MAX_NO_CODE = 3;

        let code = null;
        let no_code_failures = 0;
        let last_lint = null;
        for (let i=0; i<MAX_ATTEMPTS; i++) {
            if (this.agent.bot.interrupt_code)
                return null;
            const messages_copy = JSON.parse(JSON.stringify(messages));
            let res = await this.agent.prompter.promptCoding(messages_copy);
            if (this.agent.bot.interrupt_code)
                return null;
            // null means another coding request is already in flight, not that
            // the model declined. Retrying cannot help -- no request was made,
            // and the retry returns here instantly -- so it would just spend the
            // no-code budget and report a refusal that never happened.
            if (res === null)
                return 'Another action is already writing code. Wait for it to finish before starting a new one.';
            let contains_code = res.indexOf('```') !== -1;
            if (!contains_code) {
                if (res.indexOf('!newAction') !== -1) {
                    messages.push({
                        role: 'assistant', 
                        content: res.substring(0, res.indexOf('!newAction'))
                    });
                    continue; // using newaction will continue the loop
                }
                
                if (no_code_failures >= MAX_NO_CODE) {
                    console.warn("Action failed, agent would not write code.");
                    return 'Action failed, agent would not write code.';
                }
                messages.push({
                    role: 'system', 
                    content: 'Error: no code provided. Write code in codeblock in your response. ``` // example ```'}
                );
                console.warn("No code block generated. Trying again.");
                no_code_failures++;
                continue;
            }
            code = res.substring(res.indexOf('```')+3, res.lastIndexOf('```'));
            const result = await this._stageCode(code);
            const executionModule = result.func;
            const lintResult = await this._lintCode(result.src_lint_copy);
            if (lintResult) {
                const message = 'Error: Code lint error:'+'\n'+lintResult+'\nPlease try again.';
                console.warn("Linting error:"+'\n'+lintResult+'\n');
                // The same lint error twice running means the retry loop cannot
                // converge: the docs the model was given do not change between
                // attempts, so neither does what it reaches for. Five attempts
                // at ~100-line programs took over 20 minutes to produce nothing.
                // Stop and hand the reason back, which at least lets the agent
                // pick a different approach.
                if (lintResult === last_lint) {
                    console.warn('Same lint error twice; the retry loop cannot converge.');
                    return `Could not write working code: ${lintResult}`;
                }
                last_lint = lintResult;
                messages.push({ role: 'system', content: message });
                continue;
            }
            if (!executionModule) {
                console.warn("Failed to stage code, something is wrong.");
                return 'Failed to stage code, something is wrong.';
            }

            try {
                console.log('Executing code...');
                await executionModule.main(this.agent.bot);

                const code_output = this.agent.actions.getBotOutputSummary();
                const summary = "Agent wrote this code: \n```" + this._sanitizeCode(code) + "```\nCode Output:\n" + code_output;
                return summary;
            } catch (e) {
                if (this.agent.bot.interrupt_code)
                    return null;
                
                console.warn('Generated code threw error: ' + e.toString());
                console.warn('trying again...');

                const code_output = this.agent.actions.getBotOutputSummary();

                messages.push({
                    role: 'assistant',
                    content: res
                });
                messages.push({
                    role: 'system',
                    content: `Code Output:\n${code_output}\nCODE EXECUTION THREW ERROR: ${e.toString()}\n Please try again:`
                });
            }
        }
        return `Code generation failed after ${MAX_ATTEMPTS} attempts.`;
    }
    
    async  _lintCode(code) {
        let result = '#### CODE ERROR INFO ###\n';
        const codeNoComments = code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const skillRegex = /((?:skills|world)\.(.*?))\(/g;
        const skills = [];
        let match;
        while ((match = skillRegex.exec(codeNoComments)) !== null) {
            skills.push(match[1]);
        }
        const allDocs = await this.agent.prompter.skill_libary.getAllSkillDocs();
        const knownSkills = new Set(allDocs.map(doc => doc.split('\n')[0]));
        const missingSkills = skills.filter(skill => !knownSkills.has(skill));
        if (missingSkills.length > 0) {
            // Naming the real function turns a blind retry into a targeted one.
            // The model does not invent these at random -- it reaches for
            // skills.goTo when goToPosition exists, world.getBlockAt for
            // getBlockAtPosition, world.getCraftingPlan for a thing that lives
            // somewhere else entirely. Left to guess, it burned all five
            // attempts and gave up with "Code generation failed after 5
            // attempts" four times in half an hour.
            result += 'These functions do not exist:\n';
            result += missingSkills.map(missing => {
                const suggestions = nearestSkills(missing, knownSkills);
                return suggestions.length ? `${missing}  -- did you mean: ${suggestions.join(', ')}?` : missing;
            }).join('\n');
            result += '\nUse only the functions in the skill docs above; there are no others.';
            console.log(result)
            return result;
        }

        const eslint = new ESLint();
        const results = await eslint.lintText(code);
        const codeLines = code.split('\n');
        const exceptions = results.map(r => r.messages).flat();

        if (exceptions.length > 0) {
            // A task phrased as "move a few blocks to a clear spot" retrieved no
            // movement skill (there are eight), so the model reached past the
            // library for bot.pathfinder.goto(new goals.GoalNear(...)) -- and
            // "goals" is not in the sandbox. The lint error alone says only that
            // the name is undefined, which is true five times in a row and never
            // once useful: the docs shown were chosen from the task text and
            // never change, so the retries cannot converge. What the model
            // reached FOR is the better search query, so ask the library again
            // with the undefined names and hand back what it finds.
            const undefined_names = [...new Set(exceptions
                .filter(e => e.ruleId === 'no-undef')
                .map(e => /'([^']+)'/.exec(e.message)?.[1])
                .filter(Boolean))];
            exceptions.forEach((exc, index) => {
                if (exc.line && exc.column ) {
                    const errorLine = codeLines[exc.line - 1]?.trim() || 'Unable to retrieve error line content';
                    result += `#ERROR ${index + 1}\n`;
                    result += `Message: ${exc.message}\n`;
                    result += `Location: Line ${exc.line}, Column ${exc.column}\n`;
                    result += `Related Code Line: ${errorLine}\n`;
                }
            });
            if (undefined_names.length > 0) {
                const docs = await this.agent.prompter.skill_libary.getRelevantSkillDocs(undefined_names.join(' '), 5);
                result += `\nOnly bot, skills, world, Vec3 and log are in scope -- ${undefined_names.join(', ')} ` +
                    'are not, and no import can bring them in. Skills that look like what you reached for:\n' + docs + '\n';
            }
            result += 'The code contains exceptions and cannot continue execution.';
        } else {
            return null;//no error
        }

        return result ;
    }
    // write custom code to file and import it
    // write custom code to file and prepare for evaluation
    async _stageCode(code) {
        code = this._sanitizeCode(code);
        let src = '';
        // __log, not log: these are calls WE splice into the generated body, so
        // they must not resolve to whatever the model happened to name a
        // variable. "let log = world.getNearestBlock(bot, 'pine_log', 16)" is a
        // thing it writes constantly in a forest, and it shadowed every one of
        // these for the rest of the body. See bots/execTemplate.js.
        code = code.replaceAll('console.log(', '__log(bot,');
        code = code.replaceAll('log("', '__log(bot,"');

        console.log(`Generated code: """${code}"""`);

        // this may cause problems in callback functions
        // This one is the interrupt check spliced after every statement, so a
        // shadowed `log` broke it on the SAME line that declared the shadow --
        // which is how "let log = ..." turned into "log is not a function"
        // before the code had done anything at all.
        code = code.replaceAll(';\n', '; if(bot.interrupt_code) {__log(bot, "Code interrupted.");return;}\n');
        for (let line of code.split('\n')) {
            src += `    ${line}\n`;
        }
        let src_lint_copy = this.code_lint_template.replace('/* CODE HERE */', src);
        src = this.code_template.replace('/* CODE HERE */', src);

        let filename = this.file_counter + '.js';
        // if (this.file_counter > 0) {
        //     let prev_filename = this.fp + (this.file_counter-1) + '.js';
        //     unlink(prev_filename, (err) => {
        //         console.log("deleted file " + prev_filename);
        //         if (err) console.error(err);
        //     });
        // } commented for now, useful to keep files for debugging
        this.file_counter++;
        
        let write_result = await this._writeFilePromise('.' + this.fp + filename, src);
        // This is where we determine the environment the agent's code should be exposed to.
        // It will only have access to these things, (in addition to basic javascript objects like Array, Object, etc.)
        // Note that the code may be able to modify the exposed objects.
        const compartment = makeCompartment({
            skills,
            log: skills.log,
            world,
            Vec3,
            // The model reaches for `new goals.GoalNear(...)` whenever doc
            // selection hands it no movement skill, and the sandbox had Vec3 but
            // not this -- so the attempt died on "goals is not defined" with
            // nothing in the retry telling it what to use instead. Cheaper to
            // let the obvious code work than to keep rejecting it; the lint
            // feedback below still points at the skills first.
            goals: pf.goals,
            // The lint template imports pf and the compartment did not, so
            // `new pf.goals.GoalNear(...)` -- the form the pathfinder docs use,
            // and the one the model writes about as often as the bare `goals.`
            // form -- passed lint and then died at runtime on "Cannot read
            // properties of undefined (reading 'GoalNear')". The comment on the
            // lint template asks for these two to be kept in step; this is the
            // half that was missing.
            pf,
        });
        const mainFn = compartment.evaluate(src);
        
        if (write_result) {
            console.error('Error writing code execution file: ' + write_result);
            return null;
        }
        return { func:{main: mainFn}, src_lint_copy: src_lint_copy };
    }

    _sanitizeCode(code) {
        code = code.trim();
        const remove_strs = ['Javascript', 'javascript', 'js']
        for (let r of remove_strs) {
            if (code.startsWith(r)) {
                code = code.slice(r.length);
                return code;
            }
        }
        return code;
    }

    _writeFilePromise(filename, src) {
        // makes it so we can await this function
        return new Promise((resolve, reject) => {
            writeFile(filename, src, (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }
}