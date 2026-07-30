const settings = {
    "minecraft_version": "auto", // or specific version like "1.21.6"
    "host": "127.0.0.1", // or "localhost", "your.ip.address.here"
    "port": 55916, // set to -1 to automatically scan for open ports
    "auth": "offline", // or "microsoft"

    // the mindserver manages all agents and hosts the UI
    "mindserver_host": "localhost", // address to bind the UI to. "0.0.0.0" for all interfaces,
    // or a specific address like "192.168.1.10" to expose it on one network only.
    // anything other than localhost requires mindserver_auth_token to be set.
    "mindserver_auth_token": null, // shared secret required to connect to the mindserver.
    // the UI grants full control of every agent, so this is mandatory when
    // mindserver_host is not loopback. open the UI as http://host:port/?token=YOUR_TOKEN
    "mindserver_port": 8080,
    "auto_open_ui": true, // opens UI in browser on startup
    
    "base_profile": "assistant", // survival, assistant, creative, or god_mode
    "profiles": [
        "./andy.json",
        // "./profiles/gpt.json",
        // "./profiles/claude.json",
        // "./profiles/gemini.json",
        // "./profiles/llama.json",
        // "./profiles/qwen.json",
        // "./profiles/grok.json",
        // "./profiles/mistral.json",
        // "./profiles/deepseek.json",
        // "./profiles/mercury.json",
        // "./profiles/andy-4.json", // Supports up to 75 messages!

        // using more than 1 profile requires you to /msg each bot indivually
        // individual profiles override values from the base profile
    ],

    "load_memory": false, // load memory from previous session
    "init_message": "Respond with hello world and your name", // sends to all on spawn
    "only_chat_with": [], // users that the bots listen to and send general messages to. if empty it will chat publicly

    "speak": false,
    // allows all bots to speak through text-to-speech. 
    // specify speech model inside each profile with format: {provider}/{model}/{voice}.
    // if set to "system" it will use basic system text-to-speech. 
    // Works on windows and mac, but linux requires you to install the espeak package through your package manager eg: `apt install espeak` `pacman -S espeak`.

    "chat_ingame": true, // bot responses are shown in minecraft chat
    "language": "en", // translate to/from this language. Supports these language names: https://cloud.google.com/translate/docs/languages
    "render_bot_view": false, // show bot's view in browser at localhost:3000, 3001...

    "allow_insecure_coding": false, // allows newAction command and model can write/run code on your computer. enable at own risk
    "allow_vision": false, // allows vision model to interpret screenshots as inputs
    "blocked_actions" : ["!checkBlueprint", "!checkBlueprintLevel", "!getBlueprint", "!getBlueprintLevel"] , // commands to disable and remove from docs. Ex: ["!setMode"]
    "code_timeout_mins": -1, // minutes code is allowed to run. -1 for no timeout
    "relevant_docs_count": 5, // number of relevant code function docs to select for prompting. -1 for all

    "max_messages": 15, // max number of messages to keep in context
    "num_examples": 2, // number of examples to give to the model
    "max_commands": -1, // max number of commands that can be used in consecutive responses. -1 for no limit
    "show_command_syntax": "full", // "full", "shortened", or "none"
    "narrate_behavior": true, // chat simple automatic actions ('Picking up item!')
    "chat_bot_messages": true, // publicly chat messages to other bots

    "spawn_timeout": 30, // num seconds allowed for the bot to spawn before throwing error. Increase when spawning takes a while.
    "block_place_delay": 0, // delay between placing blocks (ms) if using newAction. helps avoid bot being kicked by anti-cheat mechanisms on servers.

    "packet_error_logging": "full",
    // how to report packets the protocol library cannot parse. "full", "summary", or "off".
    // modded servers send packets that have no vanilla schema, so they can never be parsed
    // and each one is logged. they are dropped safely either way; this only controls noise.
    // "summary" logs the first, then a periodic count. NOTE: "summary" and "off" also silence
    // decompression warnings, which would indicate real stream corruption rather than a mod.

    "view_distance": "auto",
    // how much world the bot asks the server to keep loaded around it. "auto" scales
    // it to the server's measured tick rate, shrinking when the server struggles --
    // a roaming bot forces chunk generation and is often the cause of that struggle.
    // pin it with "far", "normal", "short", "tiny", or a chunk count.

    "exploration_radius": 0,
    // how far from its spawn point the bot will travel, in blocks. 0 is unlimited.
    // travelling into never-generated terrain is what costs the server most, so on
    // a modpack that stutters, keeping the bot inside explored ground helps it more
    // than it limits it.

    "mod_data": "./mod_data",
    // block/item/entity registries dumped from a modded server, so the bot can see
    // modded blocks instead of nameless undiggable air. a directory of .json packs,
    // a single file, or a list of either. generate one with tools/mod-data-dumper.

    "log_all_prompts": false, // log ALL prompts to file
};

export default settings;
