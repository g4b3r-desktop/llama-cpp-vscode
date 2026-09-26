class AgentModel {
  async next(_request) { throw new Error('AgentModel.next() must be implemented by a provider.'); }
}
module.exports = { AgentModel };
