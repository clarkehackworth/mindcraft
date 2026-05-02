import test from 'node:test';
import assert from 'node:assert/strict';
import { VisionInterpreter } from '../src/agent/vision/vision_interpreter.js';

test('VisionInterpreter reports settings-disabled vision separately from adapter support', () => {
    const interpreter = Object.create(VisionInterpreter.prototype);
    interpreter.allow_vision = false;
    interpreter.agent = { prompter: { vision_model: { sendVisionRequest: async () => 'ok' } } };

    assert.equal(
        interpreter.getVisionUnavailableMessage(),
        'Vision is disabled in settings. Set allow_vision to true and restart the agent.'
    );
});

test('VisionInterpreter reports missing image support when settings allow vision', () => {
    const interpreter = Object.create(VisionInterpreter.prototype);
    interpreter.allow_vision = true;
    interpreter.agent = { prompter: { vision_model: {} } };

    assert.equal(
        interpreter.getVisionUnavailableMessage(),
        'Vision model does not support image input. Configure a vision-capable model or adapter.'
    );
});

test('VisionInterpreter accepts adapters that implement sendVisionRequest', () => {
    const interpreter = Object.create(VisionInterpreter.prototype);
    interpreter.allow_vision = true;
    interpreter.agent = { prompter: { vision_model: { sendVisionRequest: async () => 'ok' } } };

    assert.equal(interpreter.getVisionUnavailableMessage(), null);
});
