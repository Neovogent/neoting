// Loaded before any test module. NestJS decorators call Reflect.defineMetadata,
// so the metadata registry must exist first.
import 'reflect-metadata';
