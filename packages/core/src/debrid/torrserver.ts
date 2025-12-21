import { z } from 'zod';
import {
  Env,
  ServiceId,
  createLogger,
  getSimpleTextHash,
  Cache,
  DistributedLock,
} from '../utils/index.js';
import { selectFileInTorrentOrNZB, Torrent } from './utils.js';
import {
  DebridService,
  DebridServiceConfig,
  DebridDownload,
  PlaybackInfo,
  DebridError,
} from './base.js';
import { parseTorrentTitle } from '@viren070/parse-torrent-title';
import { fetch } from 'undici';

const logger = createLogger('debrid:torrserver');

// Constants for TorrServer operations
const TORRSERVER_ADD_DELAY_MS = 2000; // Time to wait after adding a torrent
const TORRSERVER_MAX_POLL_ATTEMPTS = 10; // Maximum number of status poll attempts
const TORRSERVER_POLL_INTERVAL_MS = 11000; // Interval between status polls

export const TorrServerConfig = z.object({
  torrserverUrl: z
    .string()
    .url()
    .transform((s) => s.trim().replace(/\/+$/, '')),
  torrserverAuth: z.string().optional(),
});

interface TorrServerTorrent {
  hash: string;
  title?: string;
  size?: number;
  stat?: number; // 0 - stopped, 1 - downloading, 2 - seeding
  file_stats?: Array<{
    id: number;
    path: string;
    length: number;
  }>;
}

interface TorrServerListResponse {
  torrents: TorrServerTorrent[];
}

interface TorrServerAddResponse {
  hash: string;
}

export class TorrServerDebridService implements DebridService {
  private readonly torrserverUrl: string;
  private readonly torrserverAuth?: string;
  private static playbackLinkCache = Cache.getInstance<string, string | null>(
    'ts:link'
  );
  private static checkCache = Cache.getInstance<string, DebridDownload>(
    'ts:instant-check'
  );

  readonly supportsUsenet = false;
  readonly serviceName: ServiceId = 'torrserver';

  constructor(private readonly config: DebridServiceConfig) {
    const parsedConfig = TorrServerConfig.parse(JSON.parse(config.token));

    this.torrserverUrl = parsedConfig.torrserverUrl;
    this.torrserverAuth = parsedConfig.torrserverAuth;
  }

  private async torrserverRequest<T>(
    endpoint: string,
    options?: {
      method?: string;
      body?: any;
    }
  ): Promise<T> {
    const url = `${this.torrserverUrl}${endpoint}`;
    const method = options?.method || 'GET';

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (this.torrserverAuth) {
        headers['Authorization'] = `Basic ${this.torrserverAuth}`;
      }

      const response = await fetch(url, {
        method,
        body: options?.body ? JSON.stringify(options.body) : undefined,
        headers,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return (await response.json()) as T;
    } catch (error: any) {
      throw new DebridError('TorrServer request failed', {
        statusCode: error?.statusCode || 500,
        statusText: error?.message || 'Unknown error',
        code: 'INTERNAL_SERVER_ERROR',
        headers: {},
        body: error,
        cause: error,
      });
    }
  }

  public async listMagnets(): Promise<DebridDownload[]> {
    try {
      const response =
        await this.torrserverRequest<TorrServerListResponse>('/torrents');

      return (
        response.torrents?.map((torrent) => ({
          id: torrent.hash,
          hash: torrent.hash,
          name: torrent.title,
          size: torrent.size,
          status: this.mapTorrServerStatus(torrent.stat),
          files: torrent.file_stats?.map((file) => ({
            index: file.id,
            name: file.path,
            size: file.length,
          })),
        })) || []
      );
    } catch (error) {
      logger.error('Failed to list torrents from TorrServer:', error);
      return [];
    }
  }

  private mapTorrServerStatus(stat?: number): DebridDownload['status'] {
    switch (stat) {
      case 0:
        return 'queued';
      case 1:
        return 'downloading';
      case 2:
        return 'cached';
      default:
        return 'unknown';
    }
  }

  public async checkMagnets(
    magnets: string[],
    sid?: string
  ): Promise<DebridDownload[]> {
    const cachedResults: DebridDownload[] = [];
    const magnetsToCheck: string[] = [];

    for (const magnet of magnets) {
      const hash = this.extractHashFromMagnet(magnet);
      if (!hash) continue;

      const cacheKey = `torrserver:${getSimpleTextHash(hash)}`;
      const cached = await TorrServerDebridService.checkCache.get(cacheKey);
      if (cached) {
        cachedResults.push(cached);
      } else {
        magnetsToCheck.push(magnet);
      }
    }

    if (magnetsToCheck.length > 0) {
      // TorrServer doesn't have instant availability check, so we return as cached
      const newResults: DebridDownload[] = magnetsToCheck.map((magnet) => {
        const hash = this.extractHashFromMagnet(magnet)!;
        return {
          id: hash,
          hash,
          status: 'cached',
          files: [],
        };
      });

      newResults.forEach((item) => {
        TorrServerDebridService.checkCache
          .set(
            `torrserver:${getSimpleTextHash(item.hash!)}`,
            item,
            Env.BUILTIN_DEBRID_INSTANT_AVAILABILITY_CACHE_TTL
          )
          .catch((err) => {
            logger.error(
              `Failed to cache item ${item.hash} in the background:`,
              err
            );
          });
      });

      return [...cachedResults, ...newResults];
    }

    return cachedResults;
  }

  private extractHashFromMagnet(magnet: string): string | null {
    const match = magnet.match(/btih:([a-fA-F0-9]{40})/i);
    return match ? match[1].toLowerCase() : null;
  }

  public async addMagnet(magnet: string): Promise<DebridDownload> {
    try {
      const hash = this.extractHashFromMagnet(magnet);
      if (!hash) {
        throw new DebridError('Invalid magnet link', {
          statusCode: 400,
          statusText: 'Invalid magnet link',
          code: 'BAD_REQUEST',
          headers: {},
        });
      }

      // Add torrent to TorrServer
      await this.torrserverRequest<TorrServerAddResponse>('/torrents/add', {
        method: 'POST',
        body: {
          link: magnet,
          title: hash,
        },
      });

      // Wait a bit for TorrServer to process the torrent
      await new Promise((resolve) =>
        setTimeout(resolve, TORRSERVER_ADD_DELAY_MS)
      );

      // Get torrent info
      const torrents = await this.listMagnets();
      const torrent = torrents.find((t) => t.hash === hash);

      if (!torrent) {
        throw new DebridError('Failed to add torrent to TorrServer', {
          statusCode: 500,
          statusText: 'Failed to add torrent to TorrServer',
          code: 'INTERNAL_SERVER_ERROR',
          headers: {},
        });
      }

      return torrent;
    } catch (error) {
      if (error instanceof DebridError) {
        throw error;
      }
      throw new DebridError('Failed to add magnet to TorrServer', {
        statusCode: 500,
        statusText: error instanceof Error ? error.message : 'Unknown error',
        code: 'INTERNAL_SERVER_ERROR',
        headers: {},
        cause: error,
      });
    }
  }

  public async generateTorrentLink(
    link: string,
    clientIp?: string
  ): Promise<string> {
    // TorrServer provides direct streaming URLs
    return link;
  }

  public async resolve(
    playbackInfo: PlaybackInfo,
    filename: string,
    cacheAndPlay: boolean
  ): Promise<string | undefined> {
    const { result } = await DistributedLock.getInstance().withLock(
      `torrserver:resolve:${playbackInfo.hash}:${playbackInfo.metadata?.season}:${playbackInfo.metadata?.episode}:${playbackInfo.metadata?.absoluteEpisode}:${filename}:${cacheAndPlay}:${this.config.clientIp}`,
      () => this._resolve(playbackInfo, filename, cacheAndPlay),
      {
        timeout: cacheAndPlay ? 120000 : 30000,
        ttl: 10000,
      }
    );
    return result;
  }

  private async _resolve(
    playbackInfo: PlaybackInfo,
    filename: string,
    cacheAndPlay: boolean
  ): Promise<string | undefined> {
    if (playbackInfo.type === 'usenet') {
      throw new DebridError('TorrServer does not support usenet operations', {
        statusCode: 400,
        statusText: 'TorrServer does not support usenet operations',
        code: 'NOT_IMPLEMENTED',
        headers: {},
        body: playbackInfo,
      });
    }

    const { hash, metadata } = playbackInfo;
    const tokenHash = getSimpleTextHash(this.config.token);
    const cacheKey = `torrserver:${tokenHash}:${playbackInfo.hash}:${playbackInfo.metadata?.season}:${playbackInfo.metadata?.episode}:${playbackInfo.metadata?.absoluteEpisode}`;
    const cachedLink =
      await TorrServerDebridService.playbackLinkCache.get(cacheKey);

    let magnet = `magnet:?xt=urn:btih:${hash}`;
    if (playbackInfo.sources.length > 0) {
      magnet += `&tr=${playbackInfo.sources.join('&tr=')}`;
    }

    if (cachedLink !== undefined) {
      logger.debug(`Using cached link for ${hash}`);
      if (cachedLink === null) {
        if (!cacheAndPlay) {
          return undefined;
        }
      } else {
        return cachedLink;
      }
    }

    logger.debug(`Adding magnet to TorrServer for ${magnet}`);

    let magnetDownload = await this.addMagnet(magnet);

    logger.debug(`Magnet download added for ${magnet}`, {
      status: magnetDownload.status,
      id: magnetDownload.id,
    });

    // Poll for readiness if not ready
    if (magnetDownload.status !== 'cached') {
      TorrServerDebridService.playbackLinkCache.set(cacheKey, null, 60);
      if (!cacheAndPlay) {
        return undefined;
      }

      // Poll status when cacheAndPlay is true
      for (let i = 0; i < TORRSERVER_MAX_POLL_ATTEMPTS; i++) {
        await new Promise((resolve) =>
          setTimeout(resolve, TORRSERVER_POLL_INTERVAL_MS)
        );
        const list = await this.listMagnets();
        const magnetDownloadInList = list.find(
          (magnet) => magnet.hash === hash
        );
        if (!magnetDownloadInList) {
          logger.warn(`Failed to find ${hash} in list`);
        } else {
          logger.debug(`Polled status for ${hash}`, {
            attempt: i + 1,
            status: magnetDownloadInList.status,
          });
          if (magnetDownloadInList.status === 'cached') {
            magnetDownload = magnetDownloadInList;
            break;
          }
        }
      }
      if (magnetDownload.status !== 'cached') {
        return undefined;
      }
    }

    if (!magnetDownload.files?.length) {
      throw new DebridError('No files found for magnet download', {
        statusCode: 400,
        statusText: 'No files found for magnet download',
        code: 'NO_MATCHING_FILE',
        headers: {},
        body: magnetDownload,
      });
    }

    const torrent: Torrent = {
      type: 'torrent',
      hash,
      title: magnetDownload.name || filename,
      size: magnetDownload.size || 0,
      seeders: 1,
      sources: [],
    };

    const parsedFiles = new Map<
      string,
      {
        title?: string;
        seasons?: number[];
        episodes?: number[];
        year?: string;
      }
    >();

    for (const file of magnetDownload.files) {
      if (!file.name) continue;
      const parsed = parseTorrentTitle(file.name);
      parsedFiles.set(file.name, {
        title: parsed?.title,
        seasons: parsed?.seasons,
        episodes: parsed?.episodes,
        year: parsed?.year,
      });
    }

    const selectedFile = await selectFileInTorrentOrNZB(
      torrent,
      magnetDownload,
      parsedFiles,
      metadata,
      {
        chosenFilename: playbackInfo.filename,
        chosenIndex: playbackInfo.index,
      }
    );

    if (!selectedFile) {
      throw new DebridError('No matching file found', {
        statusCode: 400,
        statusText: 'No matching file found',
        code: 'NO_MATCHING_FILE',
        headers: {},
        body: { torrent, metadata },
      });
    }

    // Generate TorrServer stream URL
    const streamUrlObj = new URL(
      `/stream/${encodeURIComponent(selectedFile.name || '')}`,
      this.torrserverUrl
    );
    streamUrlObj.searchParams.set('link', magnet);
    streamUrlObj.searchParams.set('index', String(selectedFile.index || 0));
    const streamUrl = streamUrlObj.toString();

    // Cache the result
    await TorrServerDebridService.playbackLinkCache.set(
      cacheKey,
      streamUrl,
      Env.BUILTIN_DEBRID_PLAYBACK_LINK_CACHE_TTL
    );

    return streamUrl;
  }
}
