import { ParsedStream, UserData } from '../db/schemas.js';
import { createLogger, ServiceId, TORRSERVER_SERVICE } from '../utils/index.js';
import { TorrServerConfig } from '../debrid/torrserver.js';

const logger = createLogger('torrserver-converter');

class TorrServerConverter {
  private userData: UserData;
  private torrServerUrl?: string;
  private torrServerAuth?: string;
  private hasTorrServer: boolean = false;

  constructor(userData: UserData) {
    this.userData = userData;
    this.initializeTorrServer();
  }

  private initializeTorrServer() {
    const torrServerService = this.userData.services?.find(
      (s) => s.id === TORRSERVER_SERVICE && s.enabled !== false
    );

    if (torrServerService) {
      try {
        const config = TorrServerConfig.parse(torrServerService.credentials);
        this.torrServerUrl = config.torrserverUrl;
        this.torrServerAuth = config.torrserverAuth;
        this.hasTorrServer = true;
        
        // --- LOG DEBUG: Kiểm tra xem có đọc được User/Pass không ---
        if (this.torrServerAuth) {
           logger.info(`TorrServer Auth detected: ${this.torrServerAuth.includes(':') ? 'Basic Auth (Hidden)' : 'API Key'}`);
        } else {
           logger.warn('TorrServer configured but NO Auth credentials found!');
        }
        
      } catch (error) {
        logger.error(
          `Failed to parse TorrServer credentials: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  public async convert(streams: ParsedStream[]): Promise<ParsedStream[]> {
    if (!this.hasTorrServer || !this.torrServerUrl) {
      return streams;
    }

    let convertedCount = 0;

    const convertedStreams = streams.map((stream) => {
      if (
        stream.type === 'p2p' &&
        stream.torrent?.infoHash &&
        !stream.url &&
        !stream.externalUrl
      ) {
        const infoHash = stream.torrent.infoHash;
        const magnet = TorrServerConverter.buildMagnetLink(
          infoHash,
          stream.torrent.sources || []
        );

        // 1. Tạo URL cơ bản (chưa có auth)
        const streamUrlObj = new URL('/stream', this.torrServerUrl!);
        streamUrlObj.searchParams.set('link', magnet);
        streamUrlObj.searchParams.set('play', '1');
        streamUrlObj.searchParams.set('save', 'true');
        streamUrlObj.searchParams.set('index', stream.torrent.fileIdx !== undefined ? String(stream.torrent.fileIdx + 1) : '1');

        // Chuyển sang string trước
        let finalUrl = streamUrlObj.toString();

        // 2. XỬ LÝ AUTH THỦ CÔNG (String Injection)
        // Cách này đảm bảo auth luôn được chèn vào bất chấp môi trường
        if (this.torrServerAuth) {
            const trimmedAuth = this.torrServerAuth.trim();
            
            if (trimmedAuth.includes(':') && trimmedAuth !== '') {
                // Basic Auth: Chèn user:pass sau "://"
                // Ví dụ: https://domain.com -> https://user:pass@domain.com
                const [user, ...passParts] = trimmedAuth.split(':');
                const pass = passParts.join(':'); // Đề phòng pass cũng có dấu :
                
                // Chỉ thay thế occurrence đầu tiên của ://
                finalUrl = finalUrl.replace('://', `://${user}:${pass}@`);
            } else if (trimmedAuth !== '') {
                // API Key: Thêm vào query param (sử dụng & hoặc ? tùy trường hợp)
                const separator = finalUrl.includes('?') ? '&' : '?';
                finalUrl = `${finalUrl}${separator}apikey=${trimmedAuth}`;
            }
        }

        convertedCount++;

        return {
          ...stream,
          url: finalUrl, // Trả về URL string đã chèn auth
          type: 'debrid' as const,
          service: {
            id: TORRSERVER_SERVICE as ServiceId,
            cached: true,
          },
        };
      }

      return stream;
    });

    if (convertedCount > 0) {
      logger.info(`Converted ${convertedCount} P2P streams to TorrServer`);
    }

    return convertedStreams;
  }

  private static buildMagnetLink(infoHash: string, trackers: string[]): string {
    let magnet = `magnet:?xt=urn:btih:${infoHash}`;
    if (trackers && trackers.length > 0) {
      const encodedTrackers = trackers.map((t) => encodeURIComponent(t));
      magnet += `&tr=${encodedTrackers.join('&tr=')}`;
    }
    return magnet;
  }
}

export default TorrServerConverter;
