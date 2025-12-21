import { ParsedStream, UserData } from '../db/schemas.js';
import { createLogger, constants, ServiceId } from '../utils/index.js';
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
    // Check if TorrServer is configured in services
    const torrServerService = this.userData.services?.find(
      (s) => s.id === constants.TORRSERVER_SERVICE && s.enabled !== false
    );

    if (torrServerService) {
      try {
        const config = TorrServerConfig.parse(torrServerService.credentials);
        this.torrServerUrl = config.torrserverUrl;
        this.torrServerAuth = config.torrserverAuth;
        this.hasTorrServer = true;
        logger.info('TorrServer service configured for P2P stream conversion');
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
      // Only convert P2P streams that don't already have a URL
      if (
        stream.type === 'p2p' &&
        stream.torrent?.infoHash &&
        !stream.url &&
        !stream.externalUrl
      ) {
        const infoHash = stream.torrent.infoHash;
        const magnet = this.buildMagnetLink(
          infoHash,
          stream.torrent.sources || []
        );

        // Build TorrServer stream URL
        const streamUrlObj = new URL(
          `/stream/${encodeURIComponent(stream.filename || 'video.mkv')}`,
          this.torrServerUrl
        );
        streamUrlObj.searchParams.set('link', magnet);
        if (stream.torrent.fileIdx !== undefined) {
          streamUrlObj.searchParams.set(
            'index',
            String(stream.torrent.fileIdx)
          );
        }

        const torrServerUrl = streamUrlObj.toString();

        convertedCount++;

        return {
          ...stream,
          url: torrServerUrl,
          type: 'debrid' as const,
          service: {
            id: 'torrserver' as ServiceId,
            cached: false, // TorrServer doesn't have instant availability
          },
        };
      }

      return stream;
    });

    if (convertedCount > 0) {
      logger.info(
        `Converted ${convertedCount} P2P streams to TorrServer playback URLs`
      );
    }

    return convertedStreams;
  }

  private buildMagnetLink(infoHash: string, trackers: string[]): string {
    let magnet = `magnet:?xt=urn:btih:${infoHash}`;
    if (trackers && trackers.length > 0) {
      magnet += `&tr=${trackers.join('&tr=')}`;
    }
    return magnet;
  }
}

export default TorrServerConverter;
