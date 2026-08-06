// A no-LLM stub model for live testing. Profile: {"model": "scripted"}.
// User !commands never reach the LLM (agent.js executes them directly), so a
// bot on this model does everything tools/live_test.sh asks -- instantly, free,
// deterministic -- while system/self prompts get a canned no-op reply instead
// of a 30-second API round-trip. Set profile.params.reply to change the answer.
export class Scripted {
    static prefix = 'scripted';

    constructor(model_name, url, params) {
        this.params = params || {};
    }

    async sendRequest(turns, systemMessage, stop_seq, extra_params) {
        // '\t' is the profile-documented "nothing to say or do".
        return this.params.reply ?? '\t';
    }

    // ponytail: bag-of-chars vector, not semantic -- enough for Examples and
    // SkillLibrary to rank *something* offline. Real embeddings if example
    // selection ever matters in a scripted test.
    async embed(text) {
        const v = new Array(64).fill(0);
        for (let i = 0; i < text.length; i++) v[text.charCodeAt(i) % 64]++;
        const n = Math.hypot(...v) || 1;
        return v.map(x => x / n);
    }
}
