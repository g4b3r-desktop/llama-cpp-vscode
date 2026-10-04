const { AgentModel } = require('./AgentModel');
const { getConfig } = require('../config');

class OpenAIAgentModel extends AgentModel {
  constructor(client) { super(); this.client = client; }
  async next({ messages, tools, signal, model }) {
    const config = getConfig();
    const prepared = await this.client.prepareContext(messages, { mode: 'agent', tools, maxOutputTokens: config.agent.maxTokensPerStep, model }, signal);
    return this.client.openai.agentTurn({ messages: prepared.messages, tools, signal, model, maxOutputTokens: prepared.maxOutputTokens });
  }
}

module.exports = { OpenAIAgentModel };
