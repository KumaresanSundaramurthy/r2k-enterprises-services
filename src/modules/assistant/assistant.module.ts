import { Module } from "@nestjs/common";
import { AssistantController } from "./assistant.controller";
import { AssistantRepository } from "./assistant.repository";
import { AssistantService } from "./assistant.service";
import { GeminiClient } from "./gemini.client";

@Module({
  controllers: [AssistantController],
  providers: [AssistantService, AssistantRepository, GeminiClient],
})
export class AssistantModule {}
