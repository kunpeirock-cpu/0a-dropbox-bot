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

// ファイル種別の判定
function getFileType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (['.wav', '.mp3', '.aif', '.aiff', '.flac'].includes(ext)) return '音源';
  if (['.mp4', '.mov', '.avi', '.mkv'].includes(ext)) return 'ティザー';
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) return 'ジャケット';
  return 'その他';
}

// カテゴリー名からアーティスト名を抽出
function extractArtistName(categoryName) {
  if (!categoryName) return 'Unknown';
  return categoryName.trim();
}

// DropboxのURLからファイルをダウンロードしてDropboxにアップロード
async function downloadAndUpload(fileUrl, dropboxPath) {
  const response = await fetch(fileUrl);
  if (!response.ok) throw new Error(`ダウンロード失敗: ${response.statusText}`);
  const buffer = await response.buffer();

  await dbx.filesUpload({
    path: dropboxPath,
    contents: buffer,
    mode: { '.tag': 'overwrite' }
  });
}

// Dropboxのリンクをダウンロードリンクに変換
function toDirectLink(url) {
  // dropbox.com の共有リンクをダイレクトリンクに変換
  return url
    .replace('www.dropbox.com', 'dl.dropboxusercontent.com')
    .replace('?dl=0', '?dl=1')
    .replace('&dl=0', '&dl=1');
}

// メッセージからDropboxリンクを抽出
function extractDropboxLinks(content) {
  const regex = /https?:\/\/(?:www\.)?dropbox\.com\/[^\s>)]+/g;
  return content.match(regex) || [];
}

// ファイル名をURLから取得
function getFilenameFromUrl(url) {
  const urlObj = new URL(url.split('?')[0]);
  return path.basename(urlObj.pathname) || 'file';
}

client.on('ready', () => {
  console.log(`Bot起動: ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const links = extractDropboxLinks(message.content);
  if (links.length === 0) return;

  // カテゴリー名を取得
  const channel = message.channel;
  const category = channel.parent;
  const artistName = category ? extractArtistName(category.name) : 'Unknown';

  const results = [];
  const errors = [];

  for (const link of links) {
    try {
      const directLink = toDirectLink(link);
      const filename = getFilenameFromUrl(link);
      const fileType = getFileType(filename);
      const dropboxPath = `/${artistName}/${fileType}/${filename}`;

      await downloadAndUpload(directLink, dropboxPath);

      // 共有リンクを取得
      let shareLink = '';
      try {
        const shared = await dbx.sharingCreateSharedLinkWithSettings({
          path: dropboxPath
        });
        shareLink = shared.result.url;
      } catch (e) {
        // 既存リンクがある場合
        try {
          const existing = await dbx.sharingListSharedLinks({ path: dropboxPath });
          shareLink = existing.result.links[0]?.url || '';
        } catch {}
      }

      results.push({ filename, fileType, artistName, dropboxPath, shareLink });
    } catch (err) {
      console.error(`エラー: ${link}`, err);
      errors.push({ link, error: err.message });
    }
  }

  // 通知チャンネルに投稿
  const notifyChannel = client.channels.cache.get(NOTIFY_CHANNEL_ID);
  if (!notifyChannel) return;

  if (results.length > 0) {
    const successMsg = results.map(r =>
      `✅ **${r.filename}**\n📁 \`${r.dropboxPath}\`\n${r.shareLink ? `🔗 ${r.shareLink}` : ''}`
    ).join('\n\n');

    await notifyChannel.send(
      `📦 **Dropbox格納完了** (by ${message.author.username} / #${channel.name})\n\n${successMsg}`
    );
  }

  if (errors.length > 0) {
    const errorMsg = errors.map(e => `❌ \`${e.link}\`\nエラー: ${e.error}`).join('\n\n');
    await notifyChannel.send(`⚠️ **格納エラー**\n\n${errorMsg}`);
  }
});

client.login(process.env.DISCORD_TOKEN);
