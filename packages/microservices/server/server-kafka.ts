import { isUndefined } from '@nestjs/common/utils/shared.utils';
import { Observable } from 'rxjs';
import { Logger } from '@nestjs/common/services/logger.service';
import {
  KAFKA_DEFAULT_BROKER,
  KAFKA_DEFAULT_CLIENT,
  KAFKA_DEFAULT_GROUP
} from '../constants';
import {
  KafkaConfig,
  Kafka,
  Consumer,
  Producer,
  EachMessagePayload,
  KafkaMessage,
  Message,
  logLevel
} from '../external/kafka.interface';
import { CustomTransportStrategy, KafkaOptions, ReadPacket, PacketId } from '../interfaces';
import { KafkaHeaders } from '../enums';
import { Server } from './server';
import { partition } from 'rxjs/operators';

interface KafkaPacket {
  replyTopic?: string;
  replyPartition?: number;
}

let kafkaPackage: any = {};

export class ServerKafka extends Server implements CustomTransportStrategy {
  protected readonly logger = new Logger(ServerKafka.name);
  private client: Kafka = null;
  private consumer: Consumer = null;
  private producer: Producer = null;
  private readonly brokers: string[];
  private readonly clientId: string;
  private readonly groupId: string;

  constructor(private readonly options: KafkaOptions['options']) {
    super();
    this.brokers = this.getOptionsProp(this.options.client, 'brokers') || [KAFKA_DEFAULT_BROKER];
    this.clientId = this.getOptionsProp(this.options.client, 'clientId') || KAFKA_DEFAULT_CLIENT;
    this.groupId = this.getOptionsProp(this.options.consumer, 'groupId') || KAFKA_DEFAULT_GROUP;

    kafkaPackage = this.loadPackage('kafkajs', ServerKafka.name, () => require('kafkajs'));
  }

  public async listen(callback: () => void): Promise<void> {
    this.client = this.createClient();
    await this.start(callback);
  }

  public close(): void {
    this.consumer && this.consumer.disconnect();
    this.producer && this.producer.disconnect();
    this.consumer = null;
    this.producer = null;
    this.client = null;
  }

  public async start(callback: () => void): Promise<void> {
    // create consumer and producer
    this.consumer = this.client.consumer(Object.assign(this.options.consumer || {}, {
      groupId: this.groupId
    }));

    this.producer =  this.client.producer(this.options.producer);

    await this.consumer.connect();
    await this.producer.connect();
    await this.bindEvents(this.consumer);
    callback();
  }

  public createClient<T = any>(): T {
    const kafkaLogger = kafkaLogLevel => ({namespace, level, label, log}) => {
      let loggerMethod: string;

      switch (level) {
        case logLevel.ERROR:
        case logLevel.NOTHING:
          loggerMethod = 'error';
          break;
        case logLevel.WARN:
          loggerMethod = 'warn';
          break;
        case logLevel.INFO:
          loggerMethod = 'log';
          break;
        case logLevel.DEBUG:
        default:
          loggerMethod = 'debug';
          break;
      }

      const { message, ...others } = log;
      this.logger[loggerMethod](`${label} [${namespace}] ${message} ${JSON.stringify(others)}`);
    };

    return new kafkaPackage.Kafka(Object.assign(this.options.client || {}, {
      clientId: this.clientId,
      brokers: this.brokers,
      logCreator: kafkaLogger,
    }) as KafkaConfig);
  }

  public async bindEvents(consumer: Consumer) {
    const registeredPatterns = [...this.messageHandlers.keys()];
    await Promise.all(registeredPatterns.map(async pattern => {
      // subscribe to the pattern of the topic
      await consumer.subscribe({
        topic: pattern
      });
    }));

    await consumer.run(Object.assign(this.options.run || {}, {
      eachMessage: this.getMessageHandler()
    }));
  }

  public getMessageHandler(): Function {
    return async (payload: EachMessagePayload) => {
      return this.handleMessage(payload);
    };
  }

  public async handleMessage(
    payload: EachMessagePayload
  ) {
    const packet = this.deserialize(payload);
    const handler = this.getHandlerByPattern(packet.pattern);

    if (handler.isEventHandler) {
      return this.handleEvent(packet.pattern, packet);
    }

    // message handlers need at least a correlation id and a reply topic
    if (isUndefined(packet.id) || isUndefined(packet.replyTopic)) {
      throw new Error('Messaging not available');
    }

    const response$ = this.transformToObservable(
      await handler(packet.data),
    ) as Observable<any>;

    const publish = <T>(data: T) =>
      this.sendMessage(
        data as T & Message,
        packet.replyTopic,
        packet.replyPartition,
        packet.id
      );

    response$ && this.send(response$, publish);
  }

  private deserialize(payload: EachMessagePayload): KafkaPacket & ReadPacket<Message> & PacketId {
    // build
    const packet = {
      id: undefined,
      replyTopic: undefined,
      replyPartition: undefined,
      pattern: payload.topic,
      data: Object.assign(payload.message, {
        topic: payload.topic,
        partition: payload.partition
      })
    };

    // parse the correlation id
    if (!isUndefined(packet.data.headers[KafkaHeaders.CORRELATION_ID])) {
      // assign the correlation id as the packet id
      packet.id = packet.data.headers[KafkaHeaders.CORRELATION_ID].toString();

      // parse the topic and partition
      if (!isUndefined(packet.data.headers[KafkaHeaders.REPLY_TOPIC])) {
        packet.replyTopic = packet.data.headers[KafkaHeaders.REPLY_TOPIC].toString();
      }

      if (!isUndefined(packet.data.headers[KafkaHeaders.REPLY_PARTITION])) {
        packet.replyPartition = parseFloat(packet.data.headers[KafkaHeaders.REPLY_PARTITION].toString());
      }
    }

    return packet;
  }

  public sendMessage<T = any>(
    message: T & Message,
    replyTopic: string,
    replyPartition: number,
    correlationId: string
  ): void {
    // assign partition
    message = Object.assign(message, {
      partition: replyPartition || undefined
    });

    // create headers if they don't exist
    if (isUndefined(message.headers)) {
      message.headers = {};
    }

    // assign the correlation id
    message.headers[KafkaHeaders.CORRELATION_ID] = Buffer.from(correlationId);

    // send
    this.producer.send(Object.assign({
      topic: replyTopic,
      messages: [message]
    }, this.options.send || {}));
  }
}
