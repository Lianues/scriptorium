import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceFS, normalizePath, parentOf, baseName } from '../lib/vfs.js';

test('normalizePath 基本规则', () => {
    assert.equal(normalizePath('world_book/x'), '/world_book/x');
    assert.equal(normalizePath('/a//b/./c/'), '/a/b/c');
    assert.equal(normalizePath('\\a\\b'), '/a/b');
    assert.equal(normalizePath('/a/../b'), '/b');
    assert.equal(normalizePath('/../x'), '/x');
    assert.equal(normalizePath('/'), '/');
    assert.throws(() => normalizePath(''), /不能为空/);
    assert.throws(() => normalizePath('   '), /不能为空/);
    assert.throws(() => normalizePath('/a\u0000b'), /控制字符/);
});

test('parentOf / baseName', () => {
    assert.equal(parentOf('/a/b.txt'), '/a');
    assert.equal(parentOf('/a'), '/');
    assert.equal(parentOf('/'), '/');
    assert.equal(baseName('/a/b.txt'), 'b.txt');
    assert.equal(baseName('/'), '/');
});

test('fs：写文件自动建父目录、读回、列目录', () => {
    const store = { nodes: { '/': { t: 'd' } } };
    const fs = new WorkspaceFS(store);

    const result = fs.write('/world_book/书/entries/0_标题.md', '正文');
    assert.equal(result.created, true);
    assert.equal(result.bytes, 6);

    assert.equal(fs.read('/world_book/书/entries/0_标题.md'), '正文');
    assert.equal(fs.isDir('/world_book/书'), true);
    assert.equal(fs.isDir('/world_book/书/entries/0_标题.md'), false);

    const listing = fs.list('/world_book/书/entries');
    assert.deepEqual(listing.map(item => item.name), ['0_标题.md']);

    assert.match(fs.listText('/world_book/书'), /entries\//);
    assert.match(fs.listText('/world_book/书/entries'), /0_标题\.md/);
});

test('fs：写入保留来源标记，覆盖后仍在', () => {
    const fs = new WorkspaceFS({ nodes: { '/': { t: 'd' } } });
    fs.write('/a.yaml', 'v1', { kind: 'book-entry', book: 'B', uid: 1, part: 'yaml' });
    fs.write('/a.yaml', 'v2');
    assert.deepEqual(fs.stat('/a.yaml')?.origin, { kind: 'book-entry', book: 'B', uid: 1, part: 'yaml' });

    fs.write('/a.yaml', 'v3', { kind: 'user' });
    assert.deepEqual(fs.stat('/a.yaml')?.origin, { kind: 'user' });
});

test('fs：删除目录递归、禁止写目录、禁止写根', () => {
    const fs = new WorkspaceFS({ nodes: { '/': { t: 'd' } } });
    fs.write('/d/a.txt', 'a');
    fs.write('/d/sub/b.txt', 'b');
    assert.equal(fs.remove('/d'), 4);
    assert.equal(fs.exists('/d/a.txt'), false);
    assert.equal(fs.exists('/d'), false);

    fs.mkdirp('/x');
    assert.throws(() => fs.write('/x', 'oops'), /目录/);
    assert.throws(() => fs.write('/', 'oops'), /根目录/);
    assert.throws(() => fs.read('/nope.txt'), /不存在/);
    assert.throws(() => fs.remove('/'), /根目录/);
});

test('fs：stats 与 totalBytes', () => {
    const fs = new WorkspaceFS({ nodes: { '/': { t: 'd' } } });
    fs.write('/a.txt', '12345');
    fs.write('/b/c.txt', '中文');
    const stats = fs.stats();
    assert.equal(stats.files, 2);
    assert.equal(stats.bytes, 11);
    assert.match(stats.text, /2 文件/);
});

test('write：不设文件 / 总量上限（只受 IndexedDB 配额约束）', () => {
    const fs = new WorkspaceFS({ nodes: { '/': { t: 'd' } } });

    const big = 'a'.repeat(5 * 1024 * 1024);
    const result = fs.write('/big.txt', big);
    assert.equal(result.bytes, 5 * 1024 * 1024);
    assert.equal(fs.read('/big.txt').length, 5 * 1024 * 1024);

    // 再叠几 MB 也不报错
    const result2 = fs.write('/dir/big2.txt', big);
    assert.equal(result2.bytes, 5 * 1024 * 1024);
    assert.ok(fs.totalBytes() >= 10 * 1024 * 1024);
});

test('move：重命名文件', () => {
    const fs = new WorkspaceFS({ nodes: { '/': { t: 'd' } } });
    fs.write('/a.txt', 'hello');

    const result = fs.move('/a.txt', '/b.txt');
    assert.equal(result.count, 1);
    assert.equal(fs.exists('/a.txt'), false);
    assert.equal(fs.read('/b.txt'), 'hello');
});

test('move：搬目录（子树一起走）', () => {
    const fs = new WorkspaceFS({ nodes: { '/': { t: 'd' } } });
    fs.write('/world_book/甲/entries/0_a.md', '正文');
    fs.write('/world_book/甲/_metadata.yaml', 'name: 甲');

    fs.move('/world_book/甲', '/world_book/乙');

    assert.equal(fs.isDir('/world_book/乙'), true);
    assert.equal(fs.exists('/world_book/甲'), false);
    assert.equal(fs.read('/world_book/乙/entries/0_a.md'), '正文');
    assert.equal(fs.exists('/world_book/乙/_metadata.yaml'), true);
});

test('move：目录改名后仍能继续写', () => {
    const fs = new WorkspaceFS({ nodes: { '/': { t: 'd' } } });
    fs.write('/x/1.txt', '1');
    fs.move('/x', '/y');
    fs.write('/y/2.txt', '2');
    assert.deepEqual(fs.files().sort(), ['/y/1.txt', '/y/2.txt']);
});

test('move：错误情况', () => {
    const fs = new WorkspaceFS({ nodes: { '/': { t: 'd' } } });
    fs.write('/a.txt', 'a');
    fs.write('/b.txt', 'b');

    assert.throws(() => fs.move('/nope', '/c.txt'), /找不到/);
    assert.throws(() => fs.move('/a.txt', '/b.txt'), /已存在/);
    assert.throws(() => fs.move('/', '/z'), /根目录/);

    fs.mkdirp('/dir/sub');
    fs.write('/dir/sub/x.txt', 'x');
    assert.throws(() => fs.move('/dir', '/dir/sub/y'), /自己里面/);
});
