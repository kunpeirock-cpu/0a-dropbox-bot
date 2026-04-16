const { Client, GatewayIntentBits } = require('discord.js');
const { Dropbox } = require('dropbox');
const fetch = require('node-fetch');
const path = require('path');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

const dbx = new Dropbox({
  accessToken: process.env.DROPBOX_TOKEN,
  fetch: fetch
});

const NOTIFY_CHANNEL_ID = process.env.NOTIFY_CHANNEL_ID;

function getFileType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (['.wav', '.mp3', '.aif', '.aiff', '.flac'].includes(ext)) return '音源';
  if (['.mp4', '.mov', '.avi', '.mkv'].includes(ext)) return 'ティザー';
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) return 'ジャケット';
  return 'その他';
}

function extractArtistName(categoryName) {
  if (!categoryName) return 'Unknown';
  return categoryName.trim();
}

function isFolderLink(url) {
  return url.includes('/scl/fo/') || url.includes('/sh/') || url.includes('/fo/');
}

async function copyFromSharedFolder(sharedLink, artistName) {
  const results = [];
  const errors = [];

  let entries = [];
  try {
    const res = await dbx.filesListFolder({
      path: '',
      shared_link: { url: sharedLink }
    });
    entries = res.result.entries.filter(e => e['.tag'] === 'file');
  } catch (e) {
    throw new Error(`フォルダ一覧取得エラー: ${e.message}`);
  }

  for (const file of entries) {
    try {
      const fileType = getFileType(file.name);
      const dropboxPath = `/${artistName}/${fileType}/${file.name}`;

      const fileRes = await dbx.sharingGetSharedLinkFile({
        url: sharedLink,
        path: '/' + file.name
      });

      await dbx.filesUpload({
        path: dropboxPath,
        contents: fileRes.result.fileBinary,
        mode: { '.tag': 'overwrite' }
      });

      results.push({ filename: file.name, fileType, artistName, dropboxPath });
    } catch (e) {
      errors.push({ filename: file.name, error: e.message });
    }
  }

  return { results, errors };
}

async function copySingleFile(sharedLink, artistName) {
  const directUrl = sharedLink
    .replace('?dl=0', '?dl=1')
    .replace('&dl=0', '&dl=1')
    .replace('www.dropbox.com', 'dl.dropboxusercontent.com');

  const filename = path.basename(new URL(sharedLink.split('?')[0]).pathname) || 'file';
  const fileType = getFileType(filename);
  const dropboxPath = `/${artistName}/${fileType}/${filename}`;

  const response = await fetch(directUrl);
  if (!response.ok) throw new Error(`ダウンロード失敗: ${response.statusText}`);
  const buffer = await response.buffer();

  await dbx.filesUpload({
    path: dropboxPath,
    contents: buffer,
    mode: { '.tag': 'overwrite' }
  });

  return { filename, fileType, artistName, dropboxPath };
}

async function getShareLink(dropboxPath) {
  try {
    const shared = await dbx.sharingCreateSharedLinkWithSettings({ path: dropboxPath });
    return shared.result.url;
  } catch {
    try {
      const existing = await dbx.sharingListSharedLinks({ path: dropboxPath });
      return existing.result.links[0]?.url || '';
    } catch {
      return '';
    }
  }
}

function extractDropboxLinks(content) {
  const regex = /https?:\/\/(?:www\.)?dropbox\.com\/[^\s>)"]+/g;
  return content.match(regex) || [];
}

client.on('ready', () => {
  console.log(`Bot起動: ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const links = extractDropboxLinks(message.content);
  if (links.length === 0) return;

  const channel = message.channel;
  const category = channel.parent;
  const artistName = extractArtistName(category?.name || 'Unknown');

  const allResults = [];
  const allErrors = [];

  for (const link of links) {
    try {
      if (isFolderLink(link)) {
        const { results, errors } = await copyFromSharedFolder(link, artistName);
        allResults.push(...results);
        allErrors.push(...errors);
      } else {
        const result = await copySingleFile(link, artistName);
        allResults.push(result);
      }
    } catch (err) {
      console.error(`エラー: ${link}`, err);
      allErrors.push({ filename: link, error: err.message });
    }
  }

  const notifyChannel = client.channels.cache.get(NOTIFY_CHANNEL_ID);
  if (!notifyChannel) return;

  if (allResults.length > 0) {
    const lines = await Promise.all(allResults.map(async r => {
      const shareLink = await getShareLink(r.dropboxPath);
      return `✅ **${r.filename}**\n📁 \`/${r.artistName}/${r.fileType}/\`\n${shareLink ? `🔗 ${shareLink}` : ''}`;
    }));
    await notifyChannel.send(
      `📦 **Dropbox格納完了** (by ${message.author.username} / #${channel.name})\n\n${lines.join('\n\n')}`
    );
  }

  if (allErrors.length > 0) {
    const errorMsg = allErrors.map(e => `❌ \`${e.filename}\`\nエラー: ${e.error}`).join('\n\n');
    await notifyChannel.send(`⚠️ **格納エラー**\n\n${errorMsg}`);
  }
});

client.login(process.env.DISCORD_TOKEN);
