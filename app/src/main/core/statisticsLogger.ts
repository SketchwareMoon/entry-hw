import fs from 'fs-extra';
import path from 'path';
import axios from 'axios';
import crypto from 'crypto';
import isInternetConnected from './functions/isInternetConnected';
import os from 'os';

type Options = {
    logPath: string;
    serverUrl: string;
    networkCheckInterval: number;
    logCheckInterval: number;
};
type RequiredOptions = keyof Pick<Options, 'logPath' | 'serverUrl'>;

type DefaultOptions = Omit<Options, RequiredOptions>;
type ConstructorOptions = Partial<Options> & Pick<Options, RequiredOptions>;

type LogObject = {
    action: string;
    date: number;
    value?: { [key: string]: string };
};

const defaultOptions: DefaultOptions = {
    networkCheckInterval: 1000,
    logCheckInterval: 1000,
};

const LOG_EXTENSION = '.ehl'; // entry hardware log

/**
 * 통계용 로그를 전송하는 로거
 * 로거는 인터넷의 연결여부에 따라 다르게 동작한다.
 *
 * 인터넷에 연결되어있을 경우는 로그 수집 API 를 통해 데이터를 전달한다.
 * 인터넷에 연결되어있지 않는 경우는 로그 저장 path 에 로그데이터를 저장해두고, 추후 인터넷에 연결되는 경우 모아서 전달한다.
 *
 * 그렇기때문에 해당 로거는 바로 데이터를 전송하지 않고, 내부적으로 queue 가 주기적으로 체크하는 형태로 구성되어있다.
 * log() 함수는 로그를 전송하는 것이 아닌 queue 에 로그를 등록하는 역할을 한다.
 */
class StatisticsLogger {
    private options?: Options;
    private logQueue: LogObject[] = [];
    private isInternetConnected: boolean = true;
    private lastInternetConnectedFlag = false;
    private connectionCheckInterval?: number;
    private queueCheckInterval?: number;
    private defaultLoggerInfo = {
        osType: os.type(),
    };

    public setOptions(nextOptions: ConstructorOptions) {
        if (!nextOptions.logPath) {
            throw new Error('logPath property must be presented');
        }
        if (!nextOptions.serverUrl) {
            throw new Error('server url must be presented');
        }

        this.options = Object.assign<DefaultOptions, ConstructorOptions>(
            defaultOptions,
            nextOptions
        );
    }

    public run() {
        if (!this.options) {
            throw new Error('option is not defined');
        }

        if (this.queueCheckInterval || this.connectionCheckInterval) {
            this.stop();
        }

        this.checkInternetConnected();
        this.checkLoggerQueue();
    }

    public stop() {
        clearInterval(this.connectionCheckInterval);
        clearInterval(this.queueCheckInterval);
    }

    /**
     * 로그를 쌓는다. 만약 인터넷에 연결되어있는 상태로 판단되는 경우는 바로 서버로 전송하고, 그렇지 않은 경우에는 파일로 로그를 떨군다.
     * options 가 세팅되지 않은 경우는 log 함수가 호출되어도 큐에 쌓지 않는다.
     * @param action
     * @param value
     */
    public log(action: string, value?: { [key: string]: string }) {
        this.options &&
            this.logQueue.push({
                action,
                value,
                date: Date.now(),
                ...this.defaultLoggerInfo,
            });
    }

    /**
     * 주기적으로 인터넷에 연결되어있는지 확인한다. 사용처가 async 일 필요가 없도록 플래그를 통해 관리한다.
     * @private
     */
    private checkInternetConnected() {
        this.connectionCheckInterval = setInterval(async () => {
            this.isInternetConnected = await isInternetConnected();
        }, this.options!.networkCheckInterval);
    }

    /**
     * 주기적으로 로그가 담겨있는 queue 를 검사한다.
     * queue 에 데이터가 있고 인터넷 연결이 되어있는 경우 서버로 전송한다.
     * queue 에 데이터가 없고 인터넷 연결이 되어있지 않은 경우, 가진 큐 모두를 파일로 작성한다.
     *
     * 만약 인터넷이 연결되지 않았다가 새로 연결이 된 것으로 판단되는 경우, 다시 파일시스템에 있는 로그들을 불러온다.
     * (이때 로그는 삭제한다)
     *
     * @private
     */
    private checkLoggerQueue() {
        this.queueCheckInterval = setInterval(async () => {
            const logObject = this.logQueue.shift();

            if (logObject) {
                if (this.isInternetConnected) {
                    // 혹시 파일로 남아있는 로그가 있는지 체크한다.
                    // 서버로 로그를 보낸다
                    if (!this.lastInternetConnectedFlag) {
                        await this.loadLogFiles();
                        this.lastInternetConnectedFlag = true;
                    }

                    await this.sendLogToServer(logObject);
                } else {
                    this.lastInternetConnectedFlag = false;
                    // 인터넷이 연결되어있지 않은 경우
                    // 큐에 있는 값들을 전부 파일로 전환한다.
                    await this.sendLogToFile(logObject);
                }
            }
        }, this.options!.logCheckInterval);
    }

    private async loadLogFiles() {
        try {
            const logPath = this.options!.logPath;

            await fs.ensureDir(logPath);
            const logFiles = await fs.readdir(logPath);

            await Promise.all(
                logFiles
                    .filter((fileName) => path.extname(fileName).toLowerCase() === LOG_EXTENSION)
                    .map(async (fileName) => {
                        try {
                            const targetLogFile = path.join(logPath, fileName);
                            const fileContent = await fs.readFile(targetLogFile);
                            const logObject = JSON.parse(fileContent as any) as LogObject;
                            logObject && this.logQueue.push(logObject);
                            await fs.unlink(targetLogFile);
                        } catch (e) {
                            //TODO 여기는 뭔가 상정되지 않은 에러가 발생한 경우이므로 기록을 남기거나 해야한다.
                            this.log('unexpected', { error: e });
                            console.error(e);
                        }
                    })
            );
        } catch (e) {
            console.error('logPath load failed', e);
        }
    }

    private async sendLogToServer(logObject: LogObject) {
        try {
            const { action, value, date } = logObject;
            await axios.get(this.options!.serverUrl, {
                params: { action, date, ...value },
            });
        } catch (e) {
            // 만약 에러가 발생한 경우, 다시 큐에 집어넣는다.
            this.logQueue.push(logObject);
        }
    }

    private async sendLogToFile(logObject: LogObject) {
        try {
            const fileName = crypto.randomBytes(20).toString('hex');
            await fs.writeFile(
                path.join(this.options!.logPath, `${fileName}${LOG_EXTENSION}`),
                JSON.stringify(logObject)
            );
        } catch (e) {
            //TODO 여기는 뭔가 상정되지 않은 에러가 발생한 경우이므로 기록을 남기거나 해야한다.
            console.error(e);
        }
    }
}

export type StatisticsLoggerOptions = ConstructorOptions;
export default new StatisticsLogger();
