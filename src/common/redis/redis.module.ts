import { Global, Module } from "@nestjs/common";
import { RedisService } from "./redis.service";
import { UpstashService } from "./upstash.service";

@Global()
@Module({
  providers: [RedisService, UpstashService],
  exports: [RedisService, UpstashService],
})
export class RedisModule {}
