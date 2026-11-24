#pragma once

#include <pthread.h>
#include <sched.h>

namespace foothold {

struct CpuRange {
    int first, last;
};

cpu_set_t allowed_cpus();
cpu_set_t select_cpus(const cpu_set_t&, CpuRange, bool require_all);
bool overlaps(const cpu_set_t&, const cpu_set_t&);
void pin_thread(const cpu_set_t&);
void normal_thread();
void name_thread(const char*);
bool set_fifo(int priority);
void report_schedule(const char* role, pthread_t thread, int requested_priority);

}
