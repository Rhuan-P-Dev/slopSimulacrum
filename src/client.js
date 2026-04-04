const readline = require('readline');

const SERVER_URL = 'http://localhost:3000/chat';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Maintain conversation history for context
const conversationHistory = [
    { role: 'system', content: 'You are a helpful assistant acting as part of the SlopSimulacrum project.' }
];

async function sendChatRequest(prompt) {
    conversationHistory.push({ role: 'user', content: prompt });

    try {
        const response = await fetch(SERVER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: conversationHistory })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.details || errorData.error || `HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        const assistantResponse = data.response;

        // Save assistant response to history
        conversationHistory.push({ role: 'assistant', content: assistantResponse });
        
        return assistantResponse;
    } catch (error) {
        throw new Error(`Client Error: ${error.message}`);
    }
}

function startChat() {
    console.log('--- SlopSimulacrum CLI Client ---');
    console.log('Type your prompt and press Enter. Type "exit" or "quit" to stop.\n');

    const askQuestion = () => {
        rl.question('User: ', async (input) => {
            if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
                console.log('Closing client...');
                rl.close();
                return;
            }

            if (!input.trim()) {
                askQuestion();
                return;
            }

            try {
                const response = await sendChatRequest(input);
                console.log(`\nAssistant: ${response}\n`);
            } catch (error) {
                console.error(`\n[Error] ${error.message}\n`);
            }

            askQuestion();
        });
    };

    askQuestion();
}

startChat();
