/**
 * Remotion CLI configuration.
 * @see https://www.remotion.dev/docs/config
 */
import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);
Config.setConcurrency(2);