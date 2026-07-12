import { registerRootComponent } from 'expo';
import { Platform } from 'react-native';
import App from './App';

registerRootComponent(App);

// Widgets are Android-only; guard so this never touches the web/iOS bundle.
if (Platform.OS === 'android') {
  const { registerWidgetTaskHandler } = require('react-native-android-widget') as typeof import('react-native-android-widget');
  const { widgetTaskHandler } = require('./src/widgets/widget-task-handler') as typeof import('./src/widgets/widget-task-handler');
  registerWidgetTaskHandler(widgetTaskHandler);

  // Alarm Stop/Snooze must work with the app killed — this handler runs headless.
  const notifee = (require('react-native-notify-kit') as typeof import('react-native-notify-kit')).default;
  const { handleAlarmEvent } = require('./src/alarms') as typeof import('./src/alarms');
  notifee.onBackgroundEvent(async ({ type, detail }) => {
    await handleAlarmEvent(type, detail, null);
  });
}
