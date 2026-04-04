const LLMController = require('../../src/controllers/LLMController');

/**
 * Simple test script to verify the LLMController functionality.
 * This script sends a basic prompt to the LLM backend and prints the response.
 */
async function runTest() {
    const llm = new LLMController();
    
    const messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello! This is a test of the LLMController. Are you working?' }
    ];

    try {
        console.log('--- LLM Connection Test ---');
        console.log('Sending request to: ' + LLMController.LLM_ENDPOINT);
        
        const response = await llm.chat(messages);
        
        console.log('\n✅ Success!');
        console.log('Response from LLM:\n' + '-------------------\n' + response + '\n-------------------');
    } catch (error) {
        console.error('\n❌ Test failed!');
        console.error('Error Details:', error.message);
        console.log('\nMake sure the LLM backend is running at http://127.0.0.1:20003/');
    }
}

runTest();
