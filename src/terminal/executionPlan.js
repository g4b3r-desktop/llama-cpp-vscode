const fs = require('fs/promises');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveInsideRoot, isInsideRoot } = require('../workspace/pathSafety');

const LANGUAGES = new Map([
  ['.js', 'javascript'], ['.jsx', 'javascript'], ['.mjs', 'javascript'], ['.cjs', 'javascript'],
  ['.ts', 'typescript'], ['.tsx', 'typescript'], ['.mts', 'typescript'], ['.cts', 'typescript'],
  ['.py', 'python'], ['.html', 'html'],
  ['.php', 'php'], ['.go', 'go'],
  ['.sh', 'shell'], ['.bash', 'shell']
]);

async function detectExecutionPlan(rootPath, relativePath) {
  const resolved = resolveInsideRoot(rootPath, relativePath);
  const rootRealPath = await fs.realpath(rootPath);
  const fileRealPath = await fs.realpath(resolved.absolute);
  if (!isInsideRoot(rootRealPath, fileRealPath)) throw new Error('Execution target resolves outside the workspace.');
  const stat = await fs.stat(fileRealPath);
  if (!stat.isFile()) throw new Error('Automatic execution only supports regular text files.');
  if (stat.size > 5 * 1024 * 1024) throw new Error('Automatic execution is limited to files smaller than 5 MiB.');
  const fileHandle = await fs.open(fileRealPath, 'r');
  const prefix = Buffer.alloc(8192);
  let bytesRead;
  try { ({ bytesRead } = await fileHandle.read(prefix, 0, prefix.length, 0)); }
  finally { await fileHandle.close(); }
  if (prefix.subarray(0, bytesRead).includes(0)) throw new Error('Automatic execution is disabled for binary files.');

  const extension = path.extname(fileRealPath).toLowerCase();
  const language = LANGUAGES.get(extension);
  const relativeFile = toWorkspacePath(rootPath, fileRealPath);
  const packageConfig = await findPackageConfig(rootRealPath, path.dirname(fileRealPath));
  const metadata = await findProjectMetadata(rootRealPath, path.dirname(fileRealPath), packageConfig);
  if (!language) return { ...metadata, supported: false, path: relativeFile, reason: `No automatic runner is configured for ${extension || 'extensionless'} files.` };

  if (language === 'html') {
    const previewScript = selectManagedHtmlScript(packageConfig?.scripts);
    if (previewScript && packageConfig) {
      const manager = packageManager(packageConfig.directory, rootRealPath);
      return {
        ...metadata,
        supported: true,
        kind: 'preview-script',
        path: relativeFile,
        language,
        runtime: manager.executable,
        args: manager.args(previewScript),
        script: previewScript,
        scriptContent: packageConfig.scripts[previewScript],
        cwd: packageConfig.directory,
        command: manager.display(previewScript),
        approvalCommand: `${manager.display(previewScript)}\n\nScript definido no package.json:\n${packageConfig.scripts[previewScript]}\n\nA extensão acrescentará argumentos para vincular somente a 127.0.0.1.`
      };
    }
    const python = availableRuntime(['python3', 'python']);
    if (!python) return { ...metadata, supported: false, path: relativeFile, language, reason: 'Python is required to start a managed local HTML preview server.' };
    return { ...metadata, supported: true, kind: 'preview', path: relativeFile, language, runtime: python, cwd: rootRealPath };
  }

  if (packageConfig) {
    const script = selectProjectScript(language, packageConfig.scripts);
    if (script) {
      const manager = packageManager(packageConfig.directory, rootRealPath);
      return {
        ...metadata,
        supported: true,
        kind: script === 'test' ? 'test' : 'verify',
        path: relativeFile,
        language,
        runtime: manager.executable,
        args: manager.args(script),
        cwd: packageConfig.directory,
        command: manager.display(script),
        approvalCommand: `${manager.display(script)}\n\nScript definido no package.json:\n${packageConfig.scripts[script]}`
      };
    }
  }

  const cwd = packageConfig?.directory || rootRealPath;
  const fileFromCwd = toWorkspacePath(cwd, fileRealPath);
  if (language === 'javascript') {
    const tsRuntime = extension === '.jsx' ? await findLocalTypeScriptRuntime(cwd) : undefined;
    if (tsRuntime) {
      const runtimePath = toWorkspacePath(cwd, tsRuntime);
      return { ...metadata, supported: true, kind: 'execution', path: relativeFile, language, runtime: process.execPath, args: [runtimePath, fileFromCwd], cwd, command: `node ${runtimePath} ${fileFromCwd}` };
    }
    return { ...metadata, supported: true, kind: 'execution', path: relativeFile, language, runtime: process.execPath, args: [fileFromCwd], cwd, command: `node ${fileFromCwd}` };
  }
  if (language === 'typescript') {
    const tsRuntime = await findLocalTypeScriptRuntime(cwd);
    if (tsRuntime) {
      const runtimePath = toWorkspacePath(cwd, tsRuntime);
      return { ...metadata, supported: true, kind: 'execution', path: relativeFile, language, runtime: process.execPath, args: [runtimePath, fileFromCwd], cwd, command: `node ${runtimePath} ${fileFromCwd}` };
    }
    if (isRuntimeAvailable('bun', cwd)) {
      return { ...metadata, supported: true, kind: 'execution', path: relativeFile, language, runtime: 'bun', args: [fileFromCwd], cwd, command: `bun ${fileFromCwd}` };
    }
    const tsc = await findLocalTypeScriptCompiler(cwd);
    if (tsc) {
      const compiler = toWorkspacePath(cwd, tsc);
      return { ...metadata, supported: true, kind: 'verify', path: relativeFile, language, runtime: process.execPath, args: [compiler, '--noEmit', '--pretty', 'false'], cwd, command: `node ${compiler} --noEmit --pretty false` };
    }
    return { ...metadata, supported: false, path: relativeFile, language, reason: 'No project test script or local TypeScript compiler is available. Install dependencies explicitly or add a project check script.' };
  }
  if (language === 'python') {
    const runtime = availableRuntime(process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python']);
    if (!runtime) return { ...metadata, supported: false, path: relativeFile, language, reason: 'Python runtime was not found on PATH.' };
    const args = runtime === 'py' ? ['-3', fileFromCwd] : [fileFromCwd];
    return { ...metadata, supported: true, kind: 'execution', path: relativeFile, language, runtime, args, cwd, command: `${runtime} ${args.join(' ')}` };
  }
  if (language === 'php') {
    return { ...metadata, ...runtimePlan(relativeFile, language, 'php', [fileFromCwd], cwd, 'execution') };
  }
  if (language === 'go') {
    return { ...metadata, ...runtimePlan(relativeFile, language, 'go', ['run', fileFromCwd], cwd, 'execution') };
  }
  if (language === 'shell') {
    return { ...metadata, ...runtimePlan(relativeFile, language, 'bash', [fileFromCwd], cwd, 'execution') };
  }
  return { ...metadata, supported: false, path: relativeFile, language, reason: `No automatic runner is configured for ${language}.` };
}

function runtimePlan(file, language, runtime, args, cwd, kind) {
  if (!isRuntimeAvailable(runtime, cwd)) return { supported: false, path: file, language, reason: `${runtime} runtime was not found on PATH.` };
  return { supported: true, kind, path: file, language, runtime, args, cwd, command: [runtime, ...args].join(' ') };
}

function selectProjectScript(language, scripts = {}) {
  const preferred = language === 'typescript'
    ? ['check', 'typecheck', 'test', 'build']
    : ['test', 'check', 'lint', 'build'];
  return preferred.find(name => typeof scripts[name] === 'string' && scripts[name].trim()) || null;
}

function selectManagedHtmlScript(scripts = {}) {
  return ['dev', 'preview', 'start'].find(name => typeof scripts[name] === 'string' && /^\s*vite\s*$/.test(scripts[name])) || null;
}

async function findPackageConfig(rootPath, startDirectory) {
  let directory = startDirectory;
  while (isInsideRoot(rootPath, directory)) {
    const filename = path.join(directory, 'package.json');
    try {
      const realPath = await fs.realpath(filename);
      if (!isInsideRoot(rootPath, realPath)) throw new Error('Project package configuration resolves outside the workspace.');
      const value = JSON.parse(await fs.readFile(realPath, 'utf8'));
      return {
        directory,
        scripts: value && typeof value.scripts === 'object' && value.scripts ? value.scripts : {},
        dependencies: dependencyNames(value?.dependencies, value?.devDependencies, value?.peerDependencies)
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Unable to read project package configuration: ${error.message}`);
    }
    if (directory === rootPath) break;
    directory = path.dirname(directory);
  }
  return undefined;
}

async function findProjectMetadata(rootPath, startDirectory, packageConfig) {
  const configNames = ['package.json', 'tsconfig.json', 'pyproject.toml', 'requirements.txt', 'Pipfile', 'go.mod', 'composer.json'];
  const directories = [];
  let directory = startDirectory;
  while (isInsideRoot(rootPath, directory)) {
    directories.push(directory);
    if (directory === rootPath) break;
    directory = path.dirname(directory);
  }
  const projectConfig = [];
  for (const candidateDirectory of directories) {
    for (const name of configNames) {
      if (name === 'package.json' && packageConfig?.directory === candidateDirectory) {
        projectConfig.push(toWorkspacePath(rootPath, path.join(candidateDirectory, name)));
        continue;
      }
      try {
        const filename = path.join(candidateDirectory, name);
        if (!(await fs.stat(filename)).isFile()) continue;
        const realPath = await fs.realpath(filename);
        if (!isInsideRoot(rootPath, realPath)) throw new Error(`Project configuration ${name} resolves outside the workspace.`);
        projectConfig.push(toWorkspacePath(rootPath, realPath));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  const dependencies = new Set(packageConfig?.dependencies || []);
  for (const configFile of projectConfig) {
    const configName = path.basename(configFile);
    if (!['requirements.txt', 'go.mod', 'composer.json', 'pyproject.toml', 'Pipfile'].includes(configName)) continue;
    const filename = path.resolve(rootPath, configFile);
    const stat = await fs.stat(filename);
    if (stat.size > 1024 * 1024) throw new Error(`Project dependency file ${configName} exceeds the 1 MiB inspection limit.`);
    const text = await fs.readFile(filename, 'utf8');
    for (const dependency of parseDeclaredDependencies(configName, text)) dependencies.add(dependency);
  }
  return { projectConfig, dependencies: [...dependencies].slice(0, 100) };
}

function dependencyNames(...groups) {
  return [...new Set(groups.flatMap(group => group && typeof group === 'object' ? Object.keys(group) : []))].slice(0, 100);
}

function parseDeclaredDependencies(filename, text) {
  if (filename === 'requirements.txt') {
    return text.split(/\r?\n/).map(line => line.match(/^\s*([A-Za-z0-9][A-Za-z0-9_.-]*)/)).filter(Boolean).map(match => match[1]);
  }
  if (filename === 'go.mod') {
    return text.split(/\r?\n/).map(line => line.match(/^\s*([A-Za-z0-9._/-]+)\s+v\d/)).filter(Boolean).map(match => match[1]);
  }
  if (filename === 'composer.json') {
    const manifest = JSON.parse(text);
    return dependencyNames(manifest.require, manifest['require-dev']);
  }
  if (filename === 'pyproject.toml') {
    const dependencies = [];
    for (const match of text.matchAll(/^\s*"([A-Za-z0-9][A-Za-z0-9_.-]*)[^"]*"\s*,?\s*$/gm)) dependencies.push(match[1]);
    return dependencies;
  }
  if (filename === 'Pipfile') {
    const dependencies = [];
    let inPackages = false;
    for (const line of text.split(/\r?\n/)) {
      const section = line.match(/^\s*\[([^\]]+)\]/);
      if (section) { inPackages = ['packages', 'dev-packages'].includes(section[1]); continue; }
      if (inPackages) {
        const match = line.match(/^\s*([A-Za-z0-9][A-Za-z0-9_.-]*)\s*=/);
        if (match) dependencies.push(match[1]);
      }
    }
    return dependencies;
  }
  return [];
}

function packageManager(directory, rootPath = directory) {
  let current = directory;
  while (isInsideRoot(rootPath, current)) {
    if (fileExists(path.join(current, 'pnpm-lock.yaml'))) return manager('pnpm', script => ['run', script]);
    if (fileExists(path.join(current, 'yarn.lock'))) return manager('yarn', script => ['run', script]);
    if (fileExists(path.join(current, 'bun.lockb')) || fileExists(path.join(current, 'bun.lock'))) return manager('bun', script => ['run', script]);
    if (current === rootPath) break;
    current = path.dirname(current);
  }
  return manager('npm', script => ['run', script]);
}

function manager(executable, args) {
  return {
    executable,
    args,
    display: script => `${executable} run ${script}`
  };
}

async function findLocalTypeScriptCompiler(directory) {
  const candidates = [
    path.join(directory, 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(directory, 'node_modules', 'typescript', 'bin', 'tsc.js')
  ];
  for (const candidate of candidates) {
    try {
      if (!(await fs.stat(candidate)).isFile()) continue;
      const realPath = await fs.realpath(candidate);
      if (!isInsideRoot(directory, realPath)) throw new Error('The local TypeScript compiler resolves outside the workspace.');
      return realPath;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return undefined;
}

async function findLocalTypeScriptRuntime(directory) {
  const candidates = [
    path.join(directory, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(directory, 'node_modules', 'ts-node', 'dist', 'bin.js')
  ];
  for (const candidate of candidates) {
    try {
      if (!(await fs.stat(candidate)).isFile()) continue;
      const realPath = await fs.realpath(candidate);
      if (!isInsideRoot(directory, realPath)) throw new Error('The local TypeScript runtime resolves outside the workspace.');
      return realPath;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return undefined;
}

function availableRuntime(candidates, cwd) {
  return candidates.find(candidate => isRuntimeAvailable(candidate, cwd));
}

function isRuntimeAvailable(command, cwd) {
  const args = command === 'go' ? ['version'] : ['--version'];
  const result = spawnSync(command, args, { cwd, timeout: 3000, windowsHide: true, stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function fileExists(filename) {
  try { return require('fs').statSync(filename).isFile(); }
  catch { return false; }
}

function toWorkspacePath(rootPath, absolutePath) {
  return path.relative(rootPath, absolutePath).split(path.sep).join('/') || '.';
}

module.exports = {
  LANGUAGES,
  detectExecutionPlan,
  selectProjectScript,
  selectManagedHtmlScript,
  findPackageConfig,
  findProjectMetadata,
  packageManager,
  findLocalTypeScriptRuntime,
  availableRuntime,
  isRuntimeAvailable
};
