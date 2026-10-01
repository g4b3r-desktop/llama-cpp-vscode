const { AgentModel } = require('./AgentModel');

class OpenAIAgentModel extends AgentModel {
  constructor(client) { super(); this.client = client; }
  async next({ messages, tools, signal, model }) {
    return this.client.openai.agentTurn({ messages, tools, signal, model });
  }
}

module.exports = { OpenAIAgentModel };
