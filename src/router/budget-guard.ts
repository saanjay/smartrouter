/**
 * Budget Guard
 * 
 * Enforces daily/monthly cost limits with:
 * - Real-time cost tracking
 * - Alert thresholds (warn at 80%, hard stop at 100%)
 * - Emergency free-only mode
 * - Cost forecasting
 */

/// <reference types="@cloudflare/workers-types" />

// =============================================================================
// Types
// =============================================================================

export interface BudgetConfig {
  enabled: boolean;
  dailyLimitUsd: number;
  monthlyLimitUsd: number;
  warnThreshold: number;         // 0.8 = warn at 80%
  hardStopThreshold: number;     // 1.0 = stop at 100%
  freeOnlyAfterThreshold: number; // 0.9 = free-only at 90%
}

export interface CostRecord {
  timestamp: number;
  amount: number;
  modelId: string;
  operation: string;
  tokens: number;
}

export interface BudgetStatus {
  dailySpent: number;
  dailyLimit: number;
  dailyPercent: number;
  monthlySpent: number;
  monthlyLimit: number;
  monthlyPercent: number;
  freeOnlyMode: boolean;
  hardStopped: boolean;
  alerts: string[];
  forecast: {
    dailyProjected: number;
    monthlyProjected: number;
  };
}

const DEFAULT_CONFIG: BudgetConfig = {
  enabled: true,
  dailyLimitUsd: 50,
  monthlyLimitUsd: 1000,
  warnThreshold: 0.80,
  hardStopThreshold: 1.0,
  freeOnlyAfterThreshold: 0.90,
};

// =============================================================================
// Budget Guard Class
// =============================================================================

export class BudgetGuard {
  private kv: KVNamespace;
  private config: BudgetConfig;
  
  // In-memory state
  private dailySpent: number = 0;
  private monthlySpent: number = 0;
  private lastLoadDate: string = '';
  private lastLoadMonth: string = '';
  private freeOnlyMode: boolean = false;
  private hardStopped: boolean = false;

  constructor(kv: KVNamespace, config: Partial<BudgetConfig> = {}) {
    this.kv = kv;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ===========================================================================
  // Cost Recording
  // ===========================================================================

  /**
   * Record a cost and check limits
   */
  async recordCost(record: Omit<CostRecord, 'timestamp'>): Promise<{
    allowed: boolean;
    freeOnlyMode: boolean;
    alerts: string[];
  }> {
    if (!this.config.enabled) {
      return { allowed: true, freeOnlyMode: false, alerts: [] };
    }

    // Ensure we have current day/month totals
    await this.loadTotals();

    const fullRecord: CostRecord = {
      ...record,
      timestamp: Date.now(),
    };

    // Add to totals
    this.dailySpent += record.amount;
    this.monthlySpent += record.amount;

    // Persist
    await this.persistTotals();

    // Check thresholds
    return this.checkThresholds();
  }

  /**
   * Pre-check if a request should be allowed
   */
  async preCheck(estimatedCost: number): Promise<{
    allowed: boolean;
    freeOnlyMode: boolean;
    reason?: string;
  }> {
    if (!this.config.enabled) {
      return { allowed: true, freeOnlyMode: false };
    }

    await this.loadTotals();

    const projectedDaily = this.dailySpent + estimatedCost;
    const projectedMonthly = this.monthlySpent + estimatedCost;

    // Hard stop check
    if (projectedDaily > this.config.dailyLimitUsd * this.config.hardStopThreshold) {
      this.hardStopped = true;
      return {
        allowed: false,
        freeOnlyMode: true,
        reason: `Daily limit exceeded ($${projectedDaily.toFixed(2)} > $${this.config.dailyLimitUsd})`,
      };
    }

    if (projectedMonthly > this.config.monthlyLimitUsd * this.config.hardStopThreshold) {
      this.hardStopped = true;
      return {
        allowed: false,
        freeOnlyMode: true,
        reason: `Monthly limit exceeded ($${projectedMonthly.toFixed(2)} > $${this.config.monthlyLimitUsd})`,
      };
    }

    // Free-only mode check
    if (projectedDaily > this.config.dailyLimitUsd * this.config.freeOnlyAfterThreshold) {
      this.freeOnlyMode = true;
      return {
        allowed: true,
        freeOnlyMode: true,
        reason: `Approaching daily limit, free-only mode`,
      };
    }

    return { allowed: true, freeOnlyMode: this.freeOnlyMode };
  }

  // ===========================================================================
  // Status and Reporting
  // ===========================================================================

  /**
   * Get current budget status
   */
  async getStatus(): Promise<BudgetStatus> {
    await this.loadTotals();
    const { alerts } = this.checkThresholds();

    // Calculate forecasts
    const now = new Date();
    const hoursToday = now.getHours() + now.getMinutes() / 60;
    const daysThisMonth = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

    const dailyProjected = hoursToday > 0 
      ? (this.dailySpent / hoursToday) * 24 
      : 0;
    const monthlyProjected = daysThisMonth > 0 
      ? (this.monthlySpent / daysThisMonth) * daysInMonth 
      : 0;

    return {
      dailySpent: this.dailySpent,
      dailyLimit: this.config.dailyLimitUsd,
      dailyPercent: (this.dailySpent / this.config.dailyLimitUsd) * 100,
      monthlySpent: this.monthlySpent,
      monthlyLimit: this.config.monthlyLimitUsd,
      monthlyPercent: (this.monthlySpent / this.config.monthlyLimitUsd) * 100,
      freeOnlyMode: this.freeOnlyMode,
      hardStopped: this.hardStopped,
      alerts,
      forecast: {
        dailyProjected,
        monthlyProjected,
      },
    };
  }

  /**
   * Check if we're in free-only mode
   */
  isFreeOnlyMode(): boolean {
    return this.freeOnlyMode;
  }

  /**
   * Check if hard stopped
   */
  isHardStopped(): boolean {
    return this.hardStopped;
  }

  /**
   * Reset free-only mode (for admin override)
   */
  async resetFreeOnlyMode(): Promise<void> {
    this.freeOnlyMode = false;
    this.hardStopped = false;
    await this.kv.put('budget:free_only_mode', 'false');
    await this.kv.put('budget:hard_stopped', 'false');
  }

  // ===========================================================================
  // Internal Methods
  // ===========================================================================

  private checkThresholds(): { allowed: boolean; freeOnlyMode: boolean; alerts: string[] } {
    const alerts: string[] = [];
    let allowed = true;

    const dailyPercent = this.dailySpent / this.config.dailyLimitUsd;
    const monthlyPercent = this.monthlySpent / this.config.monthlyLimitUsd;

    // Check warning threshold
    if (dailyPercent >= this.config.warnThreshold) {
      alerts.push(`⚠️ Daily budget at ${(dailyPercent * 100).toFixed(1)}% ($${this.dailySpent.toFixed(2)}/$${this.config.dailyLimitUsd})`);
    }
    if (monthlyPercent >= this.config.warnThreshold) {
      alerts.push(`⚠️ Monthly budget at ${(monthlyPercent * 100).toFixed(1)}% ($${this.monthlySpent.toFixed(2)}/$${this.config.monthlyLimitUsd})`);
    }

    // Check free-only threshold
    if (dailyPercent >= this.config.freeOnlyAfterThreshold || monthlyPercent >= this.config.freeOnlyAfterThreshold) {
      this.freeOnlyMode = true;
      alerts.push(`🆓 Free-only mode activated (${(Math.max(dailyPercent, monthlyPercent) * 100).toFixed(1)}% budget used)`);
    }

    // Check hard stop threshold
    if (dailyPercent >= this.config.hardStopThreshold) {
      this.hardStopped = true;
      allowed = false;
      alerts.push(`🛑 Daily limit exceeded! Paid requests blocked.`);
    }
    if (monthlyPercent >= this.config.hardStopThreshold) {
      this.hardStopped = true;
      allowed = false;
      alerts.push(`🛑 Monthly limit exceeded! Paid requests blocked.`);
    }

    return { allowed, freeOnlyMode: this.freeOnlyMode, alerts };
  }

  private async loadTotals(): Promise<void> {
    const today = this.getDateKey();
    const month = this.getMonthKey();

    // Check if we need to reload (new day/month)
    const isNewDay = today !== this.lastLoadDate;
    
    if (isNewDay) {
      const dailyStr = await this.kv.get(`budget:daily:${today}`);
      this.dailySpent = dailyStr ? parseFloat(dailyStr) : 0;
      this.lastLoadDate = today;
    }

    if (month !== this.lastLoadMonth) {
      const monthlyStr = await this.kv.get(`budget:monthly:${month}`);
      this.monthlySpent = monthlyStr ? parseFloat(monthlyStr) : 0;
      this.lastLoadMonth = month;
    }

    // Reset flags for new day with zero spending (fresh start)
    // This takes precedence over stored flags
    if (isNewDay && this.dailySpent === 0) {
      this.freeOnlyMode = false;
      this.hardStopped = false;
      // Also clear the stored flags
      await this.kv.delete('budget:free_only_mode');
      await this.kv.delete('budget:hard_stopped');
    } else {
      // Load mode flags only if not a fresh day
      const freeOnlyStr = await this.kv.get('budget:free_only_mode');
      const hardStoppedStr = await this.kv.get('budget:hard_stopped');
      this.freeOnlyMode = freeOnlyStr === 'true';
      this.hardStopped = hardStoppedStr === 'true';
    }
  }

  private async persistTotals(): Promise<void> {
    const today = this.getDateKey();
    const month = this.getMonthKey();

    await Promise.all([
      this.kv.put(`budget:daily:${today}`, this.dailySpent.toString(), {
        expirationTtl: 86400 * 2, // 2 days
      }),
      this.kv.put(`budget:monthly:${month}`, this.monthlySpent.toString(), {
        expirationTtl: 86400 * 35, // 35 days
      }),
      this.kv.put('budget:free_only_mode', this.freeOnlyMode.toString()),
      this.kv.put('budget:hard_stopped', this.hardStopped.toString()),
    ]);
  }

  private getDateKey(): string {
    return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  }

  private getMonthKey(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`; // YYYY-MM
  }

  /**
   * Get historical spending data
   */
  async getSpendingHistory(days: number = 7): Promise<Array<{ date: string; amount: number }>> {
    const history: Array<{ date: string; amount: number }> = [];
    const today = new Date();

    for (let i = 0; i < days; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const key = date.toISOString().split('T')[0];
      
      const amount = await this.kv.get(`budget:daily:${key}`);
      history.push({
        date: key,
        amount: amount ? parseFloat(amount) : 0,
      });
    }

    return history.reverse();
  }
}
