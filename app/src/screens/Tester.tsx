import React, { useState } from 'react';
import { StyleSheet, Text, View, Pressable, Platform, Alert } from 'react-native';
import * as Notifications from 'expo-notifications';
import { ALARM_CHANNEL_ID, REMINDER_CATEGORY_ID, setupAlarmChannelAndCategories } from '../alarms';
import { colors } from '../theme';

export function TesterScreen() {
  const [statusText, setStatusText] = useState<string>('Ready to test notifications & alarms');
  const [isTesting, setIsTesting] = useState<boolean>(false);

  const triggerNotification = async () => {
    try {
      setIsTesting(true);
      setStatusText('Scheduling Standard Notification (in 5s)...');

      // Ensure notification channel / categories exist
      await setupAlarmChannelAndCategories();

      const perm = await Notifications.requestPermissionsAsync();
      if (!perm.granted) {
        setStatusText('❌ Notification permissions missing!');
        Alert.alert('Permission Denied', 'Notification permissions are required.');
        setIsTesting(false);
        return;
      }

      await Notifications.scheduleNotificationAsync({
        content: {
          title: '🔔 Test Standard Notification',
          body: 'This is a standard notification from Scribble.',
          sound: true,
          priority: Notifications.AndroidNotificationPriority.DEFAULT,
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
          seconds: 5,
        },
      });

      setStatusText('✅ Notification scheduled! Will fire in 5 seconds.');
    } catch (err) {
      console.error(err);
      setStatusText(`❌ Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsTesting(false);
    }
  };

  const triggerAlarm = async () => {
    try {
      setIsTesting(true);
      setStatusText('Scheduling Full Ringing Alarm (in 5s)...');

      // Ensure high importance alarm channel and Stop/Snooze categories exist
      await setupAlarmChannelAndCategories();

      const perm = await Notifications.requestPermissionsAsync();
      if (!perm.granted) {
        setStatusText('❌ Notification permissions missing!');
        Alert.alert('Permission Denied', 'Notification permissions are required.');
        setIsTesting(false);
        return;
      }

      await Notifications.scheduleNotificationAsync({
        identifier: `test_alarm_${Date.now()}`,
        content: {
          title: '⏰ Test Full Alarm',
          body: 'High importance alarm with STOP & SNOOZE 10M action buttons!',
          sound: true,
          priority: Notifications.AndroidNotificationPriority.MAX,
          categoryIdentifier: REMINDER_CATEGORY_ID,
          data: { test: true, reminderId: 'test_123' },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
          seconds: 5,
          channelId: ALARM_CHANNEL_ID,
        },
      });

      setStatusText('✅ Alarm scheduled! Lock your phone or minimize app. Ringing in 5s!');
    } catch (err) {
      console.error(err);
      setStatusText(`❌ Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Notification & Alarm Tester</Text>
      <Text style={styles.subtitle}>
        Use these buttons to verify native lockscreen takeovers, ringtones, and action buttons.
      </Text>

      <View style={styles.statusBox}>
        <Text style={styles.statusText}>{statusText}</Text>
      </View>

      <View style={styles.buttonContainer}>
        <Pressable
          style={({ pressed }) => [styles.btn, styles.btnNotification, pressed && styles.btnPressed]}
          onPress={() => void triggerNotification()}
          disabled={isTesting}
        >
          <Text style={styles.btnText}>🔔 Trigger Notification (5s)</Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [styles.btn, styles.btnAlarm, pressed && styles.btnPressed]}
          onPress={() => void triggerAlarm()}
          disabled={isTesting}
        >
          <Text style={styles.btnText}>⏰ Trigger Alarm (5s)</Text>
        </Pressable>
      </View>

      <View style={styles.tipBox}>
        <Text style={styles.tipTitle}>💡 Testing Instructions:</Text>
        <Text style={styles.tipBody}>
          1. Tap <Text style={{ fontWeight: 'bold' }}>Trigger Alarm</Text>.{"\n"}
          2. Instantly lock your screen or go to the Android home screen.{"\n"}
          3. Wait 5 seconds to test the full-screen alarm ringing, sound, and STOP / SNOOZE 10M action buttons.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: 24,
    justifyContent: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: colors.text,
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    color: colors.textDim,
    textAlign: 'center',
    marginBottom: 24,
  },
  statusBox: {
    backgroundColor: colors.surface,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 24,
    alignItems: 'center',
  },
  statusText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  buttonContainer: {
    gap: 16,
    marginBottom: 32,
  },
  btn: {
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 3,
  },
  btnNotification: {
    backgroundColor: '#3B82F6',
  },
  btnAlarm: {
    backgroundColor: '#EF4444',
  },
  btnPressed: {
    opacity: 0.8,
  },
  btnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: 'bold',
  },
  tipBox: {
    backgroundColor: colors.surface,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tipTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: colors.text,
    marginBottom: 6,
  },
  tipBody: {
    fontSize: 13,
    color: colors.textDim,
    lineHeight: 20,
  },
});
