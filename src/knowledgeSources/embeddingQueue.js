function abortError() {
  const error = new Error('Embedding batch processing cancelled.');
  error.name = 'AbortError';
  return error;
}

async function runEmbeddingBatches(items, options = {}) {
  const values = Array.isArray(items) ? items : [];
  if (!values.length) return { completedBatches: 0, totalBatches: 0, completedItems: 0, totalItems: 0 };

  const batchSize = Math.max(1, Math.min(128, Math.floor(Number(options.batchSize) || 1)));
  const concurrency = Math.max(1, Math.min(8, Math.floor(Number(options.concurrency) || 1)));
  if (typeof options.processBatch !== 'function') throw new TypeError('processBatch callback is required.');

  const batches = [];
  for (let offset = 0; offset < values.length; offset += batchSize) {
    batches.push({ index: batches.length, items: values.slice(offset, offset + batchSize) });
  }

  let completedBatches = 0;
  let completedItems = 0;
  for (let offset = 0; offset < batches.length; offset += concurrency) {
    if (options.signal?.aborted) throw abortError();
    const wave = batches.slice(offset, offset + concurrency);
    const settled = await Promise.allSettled(wave.map(batch => Promise.resolve().then(() => options.processBatch(batch.items, batch.index))));
    let firstError;

    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index];
      const batch = wave[index];
      completedBatches += 1;
      if (result.status === 'fulfilled') {
        try {
          await options.onBatchSuccess?.(batch.items, result.value, batch.index);
          completedItems += batch.items.length;
        } catch (error) {
          firstError ||= error;
        }
      } else {
        firstError ||= result.reason;
      }
    }

    const progress = {
      completedBatches,
      totalBatches: batches.length,
      completedItems,
      totalItems: values.length,
      concurrency,
      batchSize
    };
    await options.onWaveComplete?.(progress);
    options.onProgress?.(progress);

    if (options.signal?.aborted) throw abortError();
    if (firstError) throw firstError;
  }

  return {
    completedBatches,
    totalBatches: batches.length,
    completedItems,
    totalItems: values.length
  };
}

module.exports = { runEmbeddingBatches };
