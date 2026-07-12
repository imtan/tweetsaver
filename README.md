# Tweet Saver

X (Twitter) のツイートをワンキーで保存するブラウザ拡張機能です。

ツイートのアーカイブ画像・JSON・画像・動画をまとめてダウンロードフォルダに保存するか、デジタルアセット管理アプリ [Eagle](https://en.eagle.cool/) に送ることができます。

## 機能

- ツイートにカーソルを合わせると保存ボタンが表示される
- ショートカットキー（デフォルト: `Alt + S`）でもワンキー保存
- 保存内容:
  - `archive.png` — ツイートのアーカイブ画像
  - `tweet.json` — ツイートのテキスト・ユーザー情報・URL など
  - `image_1.jpg` … — 添付画像
  - `video_1.mp4` … — 動画（mp4）
- 保存先は Downloads / Eagle / 両方 から選択可能
- Eagle 使用時はフォルダを指定可能
- ショートカットキーはポップアップから自由にカスタマイズ可能

## 対応ブラウザ

| フォルダ | 対象 |
|---|---|
| `tweet-saver-v2/` | Chrome / Edge |
| `tweet-saver-v2-firefox/` | Firefox |

## インストール方法

### Chrome / Edge

1. `tweet-saver-v2/` フォルダをダウンロード（またはリポジトリをクローン）
2. Chrome で `chrome://extensions` を開く
3. 右上の「デベロッパーモード」をオンにする
4. 「パッケージ化されていない拡張機能を読み込む」をクリック
5. `tweet-saver-v2/` フォルダを選択

### Firefox

1. `tweet-saver-v2-firefox/` フォルダをダウンロード
2. Firefox で `about:debugging#/runtime/this-firefox` を開く
3. 「一時的なアドオンを読み込む」をクリック
4. `tweet-saver-v2-firefox/manifest.json` を選択

## 使い方

### ツイートを保存する

ツイートにカーソルを乗せると保存ボタン（💾）が表示されます。クリックするか、ショートカットキー（デフォルト: `Alt + S`）を押すと保存されます。

保存先フォルダの構造:
```
Downloads/
└── tweets/
    └── username_tweetId/
        ├── archive.png
        ├── tweet.json
        ├── image_1.jpg
        └── video_1.mp4
```

### 設定を変更する

拡張機能のポップアップ（ブラウザのツールバーアイコン）から設定できます。

- **保存先**: Downloads / Eagle / 両方
- **Eagle フォルダ**: Eagle 起動中であれば自動でフォルダ一覧を取得
- **ショートカットキー**: クリックして任意のキーを押すと変更できる

## Eagle との連携

[Eagle](https://en.eagle.cool/) を使用する場合、Eagle アプリをバックグラウンドで起動した状態で拡張機能を使ってください。Eagle の API（`localhost:41595`）に自動で接続します。

- 画像・動画付きのツイート: 各ファイルが Eagle ライブラリに追加される
- テキストのみのツイート: ブックマークとして保存される
- ツイート本文・ユーザー名・URL がメモとして付与される

## 権限について

| 権限 | 用途 |
|---|---|
| `downloads` | ファイルをダウンロードフォルダに保存 |
| `storage` | 設定（保存先・ショートカット）を記憶 |
| `activeTab` | 現在のタブの情報を取得 |
| `x.com`, `twitter.com` | ツイートページで動作するため |
| `localhost:41595` | Eagle API との通信 |

外部サーバーへのデータ送信は一切行いません。
